---
"pome-sh": minor
---

**New `pome doctor` command: named-cause wiring verification (FDRS-634).**

Four checks, in order: (1) pome.config.json present + valid; (2) twin
reachable — boots the github twin in-process and walks the agent's real
path, root health plus the bearer-authed session route; (3) requests routed
to the twin — a static scan that names hardcoded production hosts
(file:line, e.g. "src/agent/triage.ts reads a hardcoded https://api.github.com
on line 12, ignoring POME_GITHUB_REST_URL") and looks for POME_*_REST_URL /
withPome() wiring evidence; (4) egress floor active (fails on a `*`
wildcard in POME_EGRESS_ALLOW). On failure it prints exactly one named
cause + one concrete fix and exits non-zero. All four pass on a wired copy
of `examples/triage-agent`.
