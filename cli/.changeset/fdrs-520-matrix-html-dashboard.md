---
"pome-sh": minor
---

New `pome matrix-html [results-dir]` command renders a finished `matrix.json`
into a self-contained, bilingual HTML dashboard (`report.zh.html` +
`report.en.html`) written next to the run; defaults to the newest run under
`--artifacts-dir`. The dashboard carries a leaderboard (satisfaction bars +
tokens/latency/cost/flaky table), a colorblind-safe model×scenario satisfaction
heatmap, scenario-discrimination bars, per-criterion small multiples (from each
run's `score.json`), "what we tested" tables, and a plain-language explainer
card per scenario linking its source `.md`. Charts are plain HTML/CSS (no CDN),
so the file opens offline. Closes FDRS-520.
