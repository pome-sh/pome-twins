---
"pome-sh": patch
---

Hosted runs now truly mirror self-host for agent env: `POME_TWIN_BASE_URL` is injected (derived from the session's twin URL), so agents with the standalone loopback fallback pass preflight instead of probing 127.0.0.1:3333. Errored trials name their cause — the agent's last stderr line lands in the trial row and the full stdout/stderr is written under the artifacts dir before the session is abandoned. `CLAUDE_CODE_OAUTH_TOKEN` is forwarded to agent subprocesses for Claude subscription auth. FDRS-667.
