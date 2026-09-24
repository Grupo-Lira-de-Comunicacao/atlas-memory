# Migration Plan — dedicated ATLAS MEMORY

## Source safety

The prior endpoint was associated with a client project and must not be treated as the future canonical host. No deletion of that source is authorized.

## Target

- Supabase organization: Matrix Attual
- Project: atlas-memory
- Project Ref: quypmwyqccdbjfbgimfw
- Repository: Grupo-Lira-de-Comunicacao/atlas-memory

## Sequence

1. Apply bootstrap schema to the new project.
2. Deploy Edge Function `atlas-memory`.
3. Create `ATLAS_MEMORY_API_KEY` as a project/function secret.
4. Smoke-test health/search/store/decisions/events on the new endpoint only.
5. Add governed `memory.store_decision` capability to atlas-core.
6. Export only Grupo Lira / ATLAS / MATRIX records from the legacy memory source using supported read paths.
7. Import into the new project preserving IDs where appropriate, source metadata, timestamps and supersession state.
8. Validate counts and representative records.
9. Switch ATLAS Gateway endpoint/key to the new project.
10. Re-run MCP, n8n Drive→MEMORY and mission continuity tests.
11. Observe stability before considering any cleanup of the old source.

## Cutover rule

The old source remains untouched until:
- target health is green;
- read/write operations are proven;
- Decisions are writable and readable;
- Drive→MEMORY runs against target;
- representative legacy records match;
- rollback instructions are verified.

Any deletion from the old source requires a separate deletion plan and explicit approval.
