# ATLAS MEMORY API Contract

The Edge Function accepts JSON POST requests authenticated by the `apikey` header.

## Authentication

- Header: `apikey: <ATLAS_MEMORY_API_KEY>`
- Secret value is stored only in Supabase project secrets and in the authorized ATLAS secret mechanism.
- It must never be committed to Git or stored in Google Drive.

## Existing Gateway operations

### health
Request:
```json
{"op":"health"}
```

### memory.store
Required fields:
- `title`
- `content`
- `category`

Optional:
- `source`
- `status`
- `project_id`
- `logical_key`
- `dedupe_key`
- `effective_date`
- `verified_at`
- `metadata`

The service also accepts these fields nested under `payload` for compatibility.

### memory.search
Input:
- `query` or `q`
- `limit` (1–100)

### memory.get_context
Input:
- `limit`
- `project_id` (optional)

Returns active Knowledge plus active Decisions.

### memory.get_decisions
Input:
- `limit`
- `status` (optional)

### memory.record_event
Required:
- `event_type`

Optional:
- `entity_type`
- `entity_id`
- `source`
- `occurred_at`
- `dedupe_key`
- `payload`

### memory.timeline
Input:
- `limit`
- `entity_type`
- `entity_id`
- `event_type`

## New operation prepared for publication

### memory.store_decision
Required:
- `code`
- `title`
- `decision`

Optional:
- `rationale`
- `status`
- `approved_by`
- `approved_at`
- `effective_at`
- `supersedes_code`
- `metadata`

This operation exists in the target service but must remain unreachable through the normal ATLAS surface until atlas-core publishes a governed capability and tests it.
