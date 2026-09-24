import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = "2.0.0";
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
    query = query.textSearch("search_document", queryText, {
      config: "simple",
      type: "websearch",
    });
  }

  const { data, error } = await query;
  if (error) throw new Error("knowledge_search_failed");
  const items = active(data ?? []);
  return { ok: true, items, count: items.length };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return response(204, {});
  if (req.method !== "POST") return response(405, { ok: false, error: "method_not_allowed" });

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !MEMORY_API_KEY) {
    return response(503, { ok: false, error: "service_not_configured" });
  }

  const suppliedKey = req.headers.get("apikey") ?? "";
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
      default:
        return response(400, { ok: false, error: "operation_not_allowed" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return response(500, { ok: false, error: message.slice(0, 200) });
  }
});
