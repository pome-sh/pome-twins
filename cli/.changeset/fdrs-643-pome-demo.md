---
"pome-sh": minor
---

`pome demo` — zero-auth cold start (FDRS-643). Boots a local GitHub twin, runs
the bundled demo agent for 5 isolated trials with model calls served by pome's
anonymous demo gateway (`POST /v1/demo/sessions/:id/llm`), uploads each
genuinely captured trace anonymously (`POST /v1/demo/sessions` mint,
demo_token-bearer upload + finalize), prints per-trial passed/failed verdicts
from the cloud evaluation (capture-only CLI, no local scoring), and ends with
the no-login preview link `app.pome.sh/demo/<group_id>`. At-capacity
402/429s render as honest labeled states. Adds a hidden `demo-agent`
subcommand (the spawned trial child), an `extraAgentEnv`/`egressExtraHosts`
seam on the self-host runner, and bearer-auth support on the hosted client
for the session-token surface.
