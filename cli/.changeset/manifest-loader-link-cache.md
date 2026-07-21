---
"@pome-sh/cli": minor
---

Adopt the `pome.json` / `pome.yaml` manifest for agent identity (replaces `pome.config.json`). `pome register` / `pome install` now write the portable `agent.slug` to the manifest and cache the resolved `agt_` id in gitignored `.pome/link.json` (team-gated, so forks and re-clones self-onboard by slug and never carry a foreign id). Runs resolve identity from the manifest, stamp `agent_version` (with a new `--agent-version` override), and near-miss slugs get an interactive did-you-mean confirmation.
