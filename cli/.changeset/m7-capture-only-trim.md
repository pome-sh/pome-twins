---
"pome-sh": minor
---

Capture-only run-dir trim and meta.json contract.

A completed run directory now contains exactly six files: `meta.json`, `events.jsonl`, `state_initial.json`, `state_final.json`, `stdout.txt`, and `stderr.log`. The intermediate correlation sidecars this CLI used to also write — `tool_calls.jsonl`, `state-before.json`, `state-after.json`, and `state-diff.json` — have been removed. They duplicated data already in `events.jsonl` / `state_initial.json` / `state_final.json` and only ever fed the local correlator/evaluator, which no longer runs in the OSS CLI. Consumers reading the removed files should read `events.jsonl` for the tool-call trace and `state_initial.json` / `state_final.json` for pre/post state.

`meta.json` gains two additive fields: `spec_version` (the meta.json shape version) and `twin_versions` (a map of the installed twin package versions that produced the run). Older readers that ignore unknown keys are unaffected.

`meta.json` is now uploaded alongside the trace and state blobs on the hosted `pome run`, `pome eval`, and `pome demo` paths (best-effort; a control plane that predates the meta upload route is tolerated).
