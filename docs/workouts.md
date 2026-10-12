# Workouts implementation plan

1. Add strict client-safe workout schemas and a deterministic catalog generator. Test unknown loads, equipment/unit isolation, completed-set-only records, and conservative rep progression before implementation.
2. Add a migrated SQLite per-person session store. Use transactional revision checks and request IDs for retry-safe writes; preserve imported source JSON and original exercise names without applying legacy aliases. Test authentication, capabilities, ownership, malformed imports, rollback and retries against real SQLite.
3. Add protected `/workouts` and `/api/workouts` routes using existing wrappers. Integrate module permissions and navigation (including exhaustive native capability models where applicable).
4. Build a compact mobile training surface: focus/time/equipment chips, neck-friendly default, preview with honest prior records, fast editable sets, explicit durable saves/resume and history. Provide runtime JSON preview/confirm import with no bundled personal data.
5. Run focused RED/GREEN tests, typecheck/lint and aggregate verification serialized. Add mobile persistence E2E and visual coverage to the canonical baseline workflow; inspect actual screenshots. Commit/push/open PR only; parent owns independent review. No merge/deploy.

## Boundaries

Workouts save privately in Jarvis SQLite. No Notion synchronization or canonical artifact writes. Imports preserve raw provenance, including aliases for reference only; aliases never establish exercise equivalence. Unknown equipment/load is not a comparable personal record. Records compare exact exercise, equipment, unit and side, using completed sets only. Highest load and reps at the suggested load are distinct. Generator uses recent working sets, not maximal loads; no-history loads must be entered by the user. Neck-friendly filtering is not a medical guarantee: stop/modify painful movement and prioritize form over records.

Rollback: disable the workouts capability; preserve the additive tables until backups and retention requirements are addressed. No existing user data is rewritten by migration.
