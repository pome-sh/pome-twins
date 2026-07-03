---
"pome-sh": minor
---

Add `pome eval [run-dir]` — upload an EXISTING raw trace directory to Pome cloud for authoritative evaluation and print the score (FDRS-656; capture/eval split). Validates the run dir (`events.jsonl`, `state_initial.json`, `state_final.json`, `meta.json`; `signals.jsonl` optional) with per-file named errors, mints a session via `POST /v1/eval-sessions` (requires a control plane with FDRS-655), reuses the existing presigned upload-url routes + `/finalize`, and persists `eval-session.json` in the run dir so re-runs surface the cloud's idempotent stored result. No local scoring anywhere (ADR-013). The hosted runner's upload + finalize-score orchestration moved to `src/hosted/uploadAndFinalize.ts` (behavior-preserving) so both paths share it. Exit policy: `pome eval` exits 0 only when the run was evaluated, every criterion was judged, and the score clears the threshold (A5 guard) — an UNEVAL verdict exits 1.
