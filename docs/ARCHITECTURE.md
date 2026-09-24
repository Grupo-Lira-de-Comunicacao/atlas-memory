# Architecture — ATLAS MEMORY

## Objective

Provide the canonical structured memory service for ATLAS / MATRIX ATTUAL / Grupo Lira.

## Separation of responsibilities

- **ATLAS MEMORY / Supabase**: structured current state, canonical decisions, events/timeline and references.
- **Google Drive**: human-readable documents, evidence, media, reports, snapshots and logical backups.
- **GitHub**: source code, migrations, tests and deploy history.
- **Infisical/Vault**: secrets.
- **ATLAS Gateway**: authenticated facade consumed by MCP/n8n.

## Supabase

Organization: `Matrix Attual`  
Project: `atlas-memory`  
Project Ref: `quypmwyqccdbjfbgimfw`

No client project may host central ATLAS MEMORY data.

## Collections

### Knowledge
Structured facts and project state. Supports:
- source/evidence metadata
- `project_id`
- `logical_key`
- `dedupe_key`
- supersession
- Drive references
- full-text search

### Decisions
Canonical decision collection. A Knowledge record with category `decision` is not equivalent to a Decision record.

### Events
Append-oriented timeline/audit events with optional idempotent dedupe keys.

## API compatibility

The Edge Function `atlas-memory` accepts the current Gateway operations:
- `health`
- `memory.get_context`
- `memory.search`
- `memory.get_decisions`
- `memory.timeline`
- `memory.store`
- `memory.record_event`

It also implements `memory.store_decision`, which remains unavailable to normal ATLAS callers until the gateway/capability surface is explicitly published and tested.

## Security

- Edge Function JWT verification is not relied on for the Gateway contract; requests use a dedicated `ATLAS_MEMORY_API_KEY` secret in the `apikey` header.
- Database access inside the function uses `SUPABASE_SERVICE_ROLE_KEY`.
- Tables have RLS enabled and no policies for `anon` or `authenticated`.
- No secret is committed to Git.
- Destructive migrations are not part of bootstrap.
