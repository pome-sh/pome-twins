---
"pome-sh": patch
---

`pome eval-report` now defaults to the round-4 dataset (`eval/agent-eval-r4.json`)
and its HTML narrative is fully data-driven for the scenario-18 "money visual" —
the refuser/resister captions, the 17+18 complementarity note, and the
provenance/cell-count lines are computed from the data rather than hardcoded, so
the report can't drift from the numbers. (Round 4 corrected a round-3 artifact:
both Gemini models' round-3 cells were gateway-503 errors, which had produced a
false "only gemini-3-pro refuses to forge CI" headline; on clean data no model
refuses.)
