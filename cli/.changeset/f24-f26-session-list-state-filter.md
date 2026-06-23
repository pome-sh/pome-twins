---
"pome-sh": patch
---

**F24 / F25 / F26 — `pome session list` filtering, vocab alignment, expired_reason.**

- **F24 (default to `running`)**: a fresh test account showed 20+ historical rows on `pome session list` because there was no default filter. The dashboard's twins page defaults to "running" only — CLI now matches. Added `--state running | ready | done | expired | all` flag (default `running`). `--limit` already existed. State filtering is client-side until cloud adds a query param; we over-fetch up to `min(limit*4, 200)` rows then slice locally so a non-`all` filter still returns a useful page.

- **F25 (vocab alignment)**: server emits `ready` for boot-complete and `running` for active; the dashboard collapses both into one "Running" column. Added a small `displayState()` helper that maps server `ready` → CLI display `running`. Unknown server states pass through verbatim so a future state value isn't hidden behind an undefined map.

- **F26 (`expired_reason` schema field)**: terminal sessions now expose an optional `expired_reason` (e.g., `stopped` / `ttl_elapsed` / `cloud_revoked`). CLI schema in `cli/src/types/shared.ts` accepts it as `z.string().optional()` so older cloud builds that don't emit it still parse cleanly; when present, CLI text format renders it next to the state column. Cloud-side populating this field is out of CLI scope.
