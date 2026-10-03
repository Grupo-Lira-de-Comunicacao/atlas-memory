import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = "2.1.0";
const ACTIVE_EXCLUDED = new Set(["SUPERSEDED", "HISTORICAL", "DELETED"]);
const MAX_LIMIT = 100;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrap(input: JsonObject): JsonObject {
  return isObject(input.payload) ? input.payload : input;
}

function asText(value: unknown, max = 10000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asLimit(value: unknown, fallback = 20): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function embeddingFor(text: string): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean) return null;
  try {
    const model = new Supabase.ai.Session("gte-small");
    const vector = await model.run(clean.slice(0, 12000), {
      mean_pool: true,
      normalize: true,
    });
    return Array.from(vector as number[]);
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = aa.length ^ bb.length;
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function response(status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function active<T extends { status?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !ACTIVE_EXCLUDED.has(String(row.status ?? "").toUpperCase()));
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MEMORY_API_KEY = Deno.env.get("ATLAS_MEMORY_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function health() {
  const { error } = await supabase
    .from("atlas_memory_knowledge")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) throw new Error("database_unavailable");
  return { ok: true, service: "atlas-memory", version: VERSION };
}

async function storeKnowledge(raw: JsonObject) {
  const body = unwrap(raw);
  const title = asText(body.title, 500);
  const content = asText(body.content, 100000);
  const category = asText(body.category, 120);
  if (!title || !content || !category) throw new Error("title_content_category_required");

  const metadata = isObject(body.metadata) ? body.metadata : {};
  const driveFileId = asText(metadata.drive_file_id, 300);
  const dedupeKey =
    asText(body.dedupe_key, 500) ||
    asText(metadata.sync_key, 500) ||
    asText(metadata.consolidation_key, 500) ||
    "";
  const logicalKey = asText(body.logical_key, 500) || (driveFileId ? `drive:${driveFileId}` : "");

  const embedding = asBool(body.generate_embedding, true)
    ? await embeddingFor(title + "\n" + content)
    : null;

  const row = {
    title,
    content,
    category,
    source: asText(body.source, 500) || null,
    status: asText(body.status, 80) || "approved",
    project_id: asText(body.project_id, 300) || null,
    logical_key: logicalKey || null,
    dedupe_key: dedupeKey || null,
    effective_date: asText(body.effective_date, 80) || null,
    verified_at: asText(body.verified_at, 80) || null,
    metadata,
    origin: asText(body.origin, 120) || "agent",
    trust_level: asText(body.trust_level, 80) || "agent",
    source_type: asText(body.source_type, 120) || null,
    source_id: asText(body.source_id, 500) || null,
    session_id: asText(body.session_id, 500) || null,
    observed_at: asText(body.observed_at, 80) || new Date().toISOString(),
    importance: body.importance == null ? null : Math.max(1, Math.min(10, Math.trunc(asNumber(body.importance, 5)))),
    confidence: body.confidence == null ? null : Math.max(0, Math.min(1, asNumber(body.confidence, 0.5))),
    expires_at: asText(body.expires_at, 80) || null,
    safe_to_act: asBool(body.safe_to_act, false),
    trigger_terms: Array.isArray(body.trigger_terms) ? body.trigger_terms.map((v) => asText(v, 200)).filter(Boolean).slice(0, 50) : [],
    provenance: isObject(body.provenance) ? body.provenance : {},
    embedding: embedding ? JSON.stringify(embedding) : null,
    embedding_model: embedding ? "gte-small" : null,
    embedding_updated_at: embedding ? new Date().toISOString() : null,
  };

  if (logicalKey && dedupeKey) {
    const { error: supersedeError } = await supabase
      .from("atlas_memory_knowledge")
      .update({ status: "superseded" })
      .eq("logical_key", logicalKey)
      .neq("dedupe_key", dedupeKey)
      .not("status", "in", "(superseded,historical,deleted)");
    if (supersedeError) throw new Error("knowledge_supersession_failed");
  }

  const query = dedupeKey
    ? supabase.from("atlas_memory_knowledge").upsert(row, { onConflict: "dedupe_key" })
    : supabase.from("atlas_memory_knowledge").insert(row);
  const { data, error } = await query.select(
    "id,title,content,category,source,status,project_id,logical_key,dedupe_key,effective_date,verified_at,metadata,created_at,updated_at",
  ).single();
  if (error) throw new Error("knowledge_store_failed");
  return { ok: true, id: data.id, item: data };
}

async function searchKnowledge(raw: JsonObject) {
  const body = unwrap(raw);
  const queryText = asText(body.query ?? body.q, 1000);
  const limit = asLimit(body.limit, 20);

  let query = supabase
    .from("atlas_memory_knowledge")
    .select("id,title,content,category,source,status,project_id,logical_key,dedupe_key,effective_date,verified_at,metadata,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (queryText) {
    const vector = await embeddingFor(queryText);
    const { data, error } = await supabase.rpc("atlas_memory_hybrid_search", {
      query_text: queryText,
      query_embedding: vector ? JSON.stringify(vector) : null,
      match_count: limit,
      filter_project_id: asText(body.project_id, 300) || null,
      include_untrusted: asBool(body.include_untrusted, false),
    });
    if (error) throw new Error("knowledge_hybrid_search_failed");
    const items = active(data ?? []);
    return { ok: true, items, count: items.length, mode: vector ? "hybrid" : "fts" };
  }

  const { data, error } = await query;
  if (error) throw new Error("knowledge_search_failed");
  const items = active(data ?? []);
  return { ok: true, items, count: items.length, mode: "recent" };
}

async function getContext(raw: JsonObject) {
  const body = unwrap(raw);
  const limit = asLimit(body.limit, 50);
  const projectId = asText(body.project_id, 300);

  let knowledgeQuery = supabase
    .from("atlas_memory_knowledge")
    .select("id,title,content,category,source,status,project_id,logical_key,dedupe_key,effective_date,verified_at,metadata,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (projectId) knowledgeQuery = knowledgeQuery.eq("project_id", projectId);

  const [knowledgeResult, decisionsResult] = await Promise.all([
    knowledgeQuery,
    supabase
      .from("atlas_memory_decisions")
      .select("id,code,title,decision,rationale,status,approved_by,approved_at,effective_at,supersedes_code,metadata,created_at,updated_at")
      .order("approved_at", { ascending: false, nullsFirst: false })
      .limit(limit),
  ]);
  if (knowledgeResult.error || decisionsResult.error) throw new Error("context_read_failed");

  const items = active(knowledgeResult.data ?? []);
  const decisions = active(decisionsResult.data ?? []);
  return {
    ok: true,
    items,
    decisions,
    context: { knowledge: items, decisions },
    generated_at: new Date().toISOString(),
  };
}

async function getDecisions(raw: JsonObject) {
  const body = unwrap(raw);
  const limit = asLimit(body.limit, 100);
  const status = asText(body.status, 80);

  let query = supabase
    .from("atlas_memory_decisions")
    .select("id,code,title,decision,rationale,status,approved_by,approved_at,effective_at,supersedes_code,metadata,created_at,updated_at")
    .order("approved_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new Error("decisions_read_failed");
  const items = status ? (data ?? []) : active(data ?? []);
  return { ok: true, items, count: items.length };
}

async function storeDecision(raw: JsonObject) {
  const body = unwrap(raw);
  const code = asText(body.code, 160);
  const title = asText(body.title, 500);
  const decision = asText(body.decision, 100000);
  if (!code || !title || !decision) throw new Error("code_title_decision_required");

  const row = {
    code,
    title,
    decision,
    rationale: asText(body.rationale, 100000) || null,
    status: asText(body.status, 80) || "active",
    approved_by: asText(body.approved_by, 300) || null,
    approved_at: asText(body.approved_at, 80) || new Date().toISOString(),
    effective_at: asText(body.effective_at, 80) || null,
    supersedes_code: asText(body.supersedes_code, 160) || null,
    metadata: isObject(body.metadata) ? body.metadata : {},
  };

  if (row.supersedes_code) {
    const { error: supersedeError } = await supabase
      .from("atlas_memory_decisions")
      .update({ status: "superseded" })
      .eq("code", row.supersedes_code);
    if (supersedeError) throw new Error("decision_supersession_failed");
  }

  const { data, error } = await supabase
    .from("atlas_memory_decisions")
    .upsert(row, { onConflict: "code" })
    .select("id,code,title,decision,rationale,status,approved_by,approved_at,effective_at,supersedes_code,metadata,created_at,updated_at")
    .single();
  if (error) throw new Error("decision_store_failed");
  return { ok: true, id: data.id, item: data };
}

async function recordEvent(raw: JsonObject) {
  const body = unwrap(raw);
  const eventType = asText(body.event_type, 200);
  if (!eventType) throw new Error("event_type_required");

  const payload = isObject(body.payload) ? body.payload : {};
  const dedupeKey =
    asText(body.dedupe_key, 500) ||
    asText(payload.event_key, 500) ||
    "";

  const row = {
    event_type: eventType,
    entity_type: asText(body.entity_type, 200) || null,
    entity_id: asText(body.entity_id, 500) || null,
    source: asText(body.source, 500) || null,
    occurred_at: asText(body.occurred_at, 80) || new Date().toISOString(),
    dedupe_key: dedupeKey || null,
    payload,
  };

  const query = dedupeKey
    ? supabase.from("atlas_memory_events").upsert(row, { onConflict: "dedupe_key" })
    : supabase.from("atlas_memory_events").insert(row);
  const { data, error } = await query
    .select("id,event_type,entity_type,entity_id,source,occurred_at,dedupe_key,payload,created_at")
    .single();
  if (error) throw new Error("event_store_failed");
  return { ok: true, id: data.id, item: data };
}

async function timeline(raw: JsonObject) {
  const body = unwrap(raw);
  const limit = asLimit(body.limit, 100);
  const entityType = asText(body.entity_type, 200);
  const entityId = asText(body.entity_id, 500);
  const eventType = asText(body.event_type, 200);

  let query = supabase
    .from("atlas_memory_events")
    .select("id,event_type,entity_type,entity_id,source,occurred_at,dedupe_key,payload,created_at")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (entityType) query = query.eq("entity_type", entityType);
  if (entityId) query = query.eq("entity_id", entityId);
  if (eventType) query = query.eq("event_type", eventType);

  const { data, error } = await query;
  if (error) throw new Error("timeline_read_failed");
  return { ok: true, items: data ?? [], count: (data ?? []).length };
}


async function storeEpisodic(raw: JsonObject) {
  const body = unwrap(raw);
  const snippet = asText(body.snippet ?? body.content, 100000);
  if (!snippet) throw new Error("snippet_required");
  const title = asText(body.title, 500) || null;
  const embedding = asBool(body.generate_embedding, true)
    ? await embeddingFor((title ? title + "\n" : "") + snippet)
    : null;
  const row = {
    title,
    snippet,
    project_id: asText(body.project_id, 300) || null,
    logical_key: asText(body.logical_key, 500) || null,
    dedupe_key: asText(body.dedupe_key, 500) || null,
    claim_hash: asText(body.claim_hash, 500) || null,
    source_type: asText(body.source_type, 120) || null,
    source_id: asText(body.source_id, 500) || null,
    session_id: asText(body.session_id, 500) || null,
    actor_id: asText(body.actor_id, 500) || null,
    origin: asText(body.origin, 120) || "agent",
    trust_level: asText(body.trust_level, 80) || "agent",
    observed_at: asText(body.observed_at, 80) || new Date().toISOString(),
    importance: body.importance == null ? null : Math.max(1, Math.min(10, Math.trunc(asNumber(body.importance, 5)))),
    confidence: body.confidence == null ? null : Math.max(0, Math.min(1, asNumber(body.confidence, 0.5))),
    concept_tags: Array.isArray(body.concept_tags) ? body.concept_tags.map((v) => asText(v, 200)).filter(Boolean).slice(0, 50) : [],
    expires_at: asText(body.expires_at, 80) || null,
    provenance: isObject(body.provenance) ? body.provenance : {},
    metadata: isObject(body.metadata) ? body.metadata : {},
    embedding: embedding ? JSON.stringify(embedding) : null,
    embedding_model: embedding ? "gte-small" : null,
    embedding_updated_at: embedding ? new Date().toISOString() : null,
  };
  const writer = row.dedupe_key
    ? supabase.from("atlas_memory_episodic").upsert(row, { onConflict: "dedupe_key" })
    : supabase.from("atlas_memory_episodic").insert(row);
  const { data, error } = await writer.select("*").single();
  if (error) throw new Error("episodic_store_failed");
  return { ok: true, id: data.id, item: data };
}

async function recordRecall(raw: JsonObject) {
  const body = unwrap(raw);
  const episodicId = asText(body.episodic_id, 100);
  const knowledgeId = asText(body.knowledge_id, 100);
  const queryHash = asText(body.query_hash, 500);
  if ((!episodicId && !knowledgeId) || !queryHash) throw new Error("recall_target_and_query_hash_required");
  const relevance = Math.max(0, Math.min(1, asNumber(body.relevance, 0)));
  const { data, error } = await supabase.from("atlas_memory_recall_events").insert({
    episodic_id: episodicId || null,
    knowledge_id: knowledgeId || null,
    project_id: asText(body.project_id, 300) || null,
    query_hash: queryHash,
    relevance,
    interactive: asBool(body.interactive, true),
    metadata: isObject(body.metadata) ? body.metadata : {},
  }).select("*").single();
  if (error) throw new Error("recall_record_failed");

  if (episodicId) {
    const { data: episode, error: readError } = await supabase
      .from("atlas_memory_episodic")
      .select("recall_count,total_score,max_score,query_hashes,recall_days")
      .eq("id", episodicId)
      .single();
    if (readError) throw new Error("episodic_recall_read_failed");
    const queryHashes = Array.from(new Set([...(episode.query_hashes ?? []), queryHash]));
    const today = new Date().toISOString().slice(0, 10);
    const recallDays = Array.from(new Set([...(episode.recall_days ?? []), today]));
    const { error: updateError } = await supabase.from("atlas_memory_episodic").update({
      recall_count: Number(episode.recall_count ?? 0) + 1,
      total_score: Number(episode.total_score ?? 0) + relevance,
      max_score: Math.max(Number(episode.max_score ?? 0), relevance),
      query_hashes: queryHashes,
      recall_days: recallDays,
      last_seen_at: new Date().toISOString(),
    }).eq("id", episodicId);
    if (updateError) throw new Error("episodic_recall_update_failed");
  }
  return { ok: true, item: data };
}

async function promotionCandidates(raw: JsonObject) {
  const body = unwrap(raw);
  const { data, error } = await supabase.rpc("atlas_memory_promotion_candidates", {
    candidate_limit: asLimit(body.limit, 20),
    min_score: Math.max(0, Math.min(1, asNumber(body.min_score, 0.55))),
    min_recall_count: Math.max(0, Math.trunc(asNumber(body.min_recall_count, 2))),
    min_unique_queries: Math.max(0, Math.trunc(asNumber(body.min_unique_queries, 2))),
    max_age_days: Math.max(1, Math.trunc(asNumber(body.max_age_days, 90))),
  });
  if (error) throw new Error("promotion_candidates_failed");
  return { ok: true, items: data ?? [], count: (data ?? []).length };
}

async function promoteEpisodic(raw: JsonObject) {
  const body = unwrap(raw);
  const episodicId = asText(body.episodic_id, 100);
  if (!episodicId) throw new Error("episodic_id_required");
  const { data: e, error } = await supabase.from("atlas_memory_episodic").select("*").eq("id", episodicId).single();
  if (error || !e) throw new Error("episodic_not_found");
  if (e.status !== "staged") throw new Error("episodic_not_staged");

  const row = {
    title: e.title || "Promoted episodic memory",
    content: e.snippet,
    category: asText(body.category, 120) || "episodic_promoted",
    source: e.source_type || "atlas-memory-v2",
    status: "approved",
    project_id: e.project_id,
    logical_key: e.logical_key,
    dedupe_key: e.dedupe_key ? "promoted:" + e.dedupe_key : null,
    effective_date: e.observed_at,
    verified_at: new Date().toISOString(),
    metadata: { ...(isObject(e.metadata) ? e.metadata : {}), promoted_from_episodic_id: e.id },
    origin: e.origin,
    trust_level: e.trust_level,
    source_type: e.source_type,
    source_id: e.source_id,
    session_id: e.session_id,
    observed_at: e.observed_at,
    importance: e.importance,
    confidence: e.confidence,
    provenance: e.provenance,
    embedding: e.embedding,
    embedding_model: e.embedding_model,
    embedding_updated_at: e.embedding_updated_at,
  };
  const { data: k, error: storeError } = await supabase.from("atlas_memory_knowledge").insert(row).select("*").single();
  if (storeError) throw new Error("episodic_promotion_store_failed");
  const { error: markError } = await supabase.from("atlas_memory_episodic").update({
    status: "promoted",
    promoted_knowledge_id: k.id,
    promoted_at: new Date().toISOString(),
  }).eq("id", episodicId);
  if (markError) throw new Error("episodic_promotion_mark_failed");
  return { ok: true, knowledge_id: k.id, episodic_id: episodicId, item: k };
}

async function forgetSource(raw: JsonObject) {
  const body = unwrap(raw);
  const selectorType = asText(body.selector_type, 120);
  const selectorValue = asText(body.selector_value, 500);
  if (!selectorType || !selectorValue) throw new Error("selector_required");
  const { error: blockError } = await supabase.from("atlas_memory_forgotten_sources").upsert({
    selector_type: selectorType,
    selector_value: selectorValue,
    reason: asText(body.reason, 1000) || null,
    requested_by: asText(body.requested_by, 300) || null,
    metadata: isObject(body.metadata) ? body.metadata : {},
  }, { onConflict: "selector_type,selector_value" });
  if (blockError) throw new Error("forget_blocklist_failed");

  if (selectorType === "source_id") {
    await supabase.from("atlas_memory_episodic").update({ status: "forgotten" }).eq("source_id", selectorValue);
    await supabase.from("atlas_memory_knowledge").update({ status: "deleted" }).eq("source_id", selectorValue);
  } else if (selectorType === "session_id") {
    await supabase.from("atlas_memory_episodic").update({ status: "forgotten" }).eq("session_id", selectorValue);
    await supabase.from("atlas_memory_knowledge").update({ status: "deleted" }).eq("session_id", selectorValue);
  }
  return { ok: true, selector_type: selectorType, selector_value: selectorValue };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return response(204, {});
  if (req.method !== "POST") return response(405, { ok: false, error: "method_not_allowed" });

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !MEMORY_API_KEY) {
    return response(503, { ok: false, error: "service_not_configured" });
  }

  const suppliedKey = req.headers.get("x-atlas-memory-key") ?? req.headers.get("apikey") ?? "";
  if (!suppliedKey || !safeEqual(suppliedKey, MEMORY_API_KEY)) {
    return response(401, { ok: false, error: "unauthorized" });
  }

  let body: JsonObject;
  try {
    const parsed = await req.json();
    if (!isObject(parsed)) throw new Error("invalid_body");
    body = parsed;
  } catch {
    return response(400, { ok: false, error: "invalid_json" });
  }

  const op = asText(body.op, 120);

  try {
    switch (op) {
      case "health":
        return response(200, await health());
      case "memory.store":
        return response(200, await storeKnowledge(body));
      case "memory.search":
        return response(200, await searchKnowledge(body));
      case "memory.get_context":
        return response(200, await getContext(body));
      case "memory.get_decisions":
        return response(200, await getDecisions(body));
      case "memory.store_decision":
        return response(200, await storeDecision(body));
      case "memory.record_event":
        return response(200, await recordEvent(body));
      case "memory.timeline":
        return response(200, await timeline(body));
      case "memory.episodic_store":
        return response(200, await storeEpisodic(body));
      case "memory.recall":
        return response(200, await recordRecall(body));
      case "memory.promotion_candidates":
        return response(200, await promotionCandidates(body));
      case "memory.promote":
        return response(200, await promoteEpisodic(body));
      case "memory.forget_source":
        return response(200, await forgetSource(body));
      default:
        return response(400, { ok: false, error: "operation_not_allowed" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return response(500, { ok: false, error: message.slice(0, 200) });
  }
});
