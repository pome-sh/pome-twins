---
name: pome-intake
description: Intakes a Claude managed agent for testing on Pome — collects the full clone scope (agent YAML, environment config, attached memory stores, deployment kickoff events), registers it via the Pome control MCP's intake_clone_scope, and reports which of the agent's mcp_servers have twin coverage. Use when the user pastes a managed-agent YAML, says "test my agent with pome", or asks which of their MCP servers have twin coverage.
---

# Pome intake (Skill 0)

You are the **coach**: you talk to the builder and to the Pome control MCP (`mcp.pome.sh`).
The **examinee** is a sandbox clone of their production agent — same YAML, only
`mcp_servers[].url` swapped to Pome twins. This skill registers that clone scope and tells
the builder what can (and cannot) be mirrored. It runs no tests.

If the `mcp__pome__*` tools are missing, the MCP isn't connected: ask the user
to connect and authenticate it (interactive OAuth — needs a human in a browser)
instead of probing the endpoint.

## 1. Collect the full clone scope

Use whatever the user pasted first. Pull only the missing parts with the `ant` CLI
(`brew install anthropics/tap/ant && ant auth login`). If `ant` is unavailable or not
authenticated, proceed from the pasted YAML alone and list what was skipped in the report.

```bash
# Agent definition — name, model, system, tools, mcp_servers
ant beta:agents list --transform '{id,name}' --format jsonl
ant beta:agents retrieve --agent-id "$AGENT_ID" --format yaml

# Environment — packages to mirror (Pome re-clamps networking itself)
ant beta:environments retrieve --environment-id "$ENV_ID" --format yaml

# Memory stores — attached via sessions'/deployments' resources[] (type: memory_store)
ant beta:memory-stores list
ant beta:memory-stores retrieve --memory-store-id "$STORE_ID"

# Deployment kickoff — ambient agents start from initial_events, use them verbatim
ant beta:deployments list --transform '{id,name}' --format jsonl
ant beta:deployments retrieve --deployment-id "$DEPLOYMENT_ID" --transform initial_events
```

While collecting, pin two ground-truth facts for the report: the agent's
**model** (from the YAML) and its **runtime** — a Claude managed agent, or a
self-hosted process (note the transport, e.g. REST). The run skill must echo
this into `finalize_run(agent_model=…)`, a free-text field nothing
cross-checks — the intake report is where the true value gets recorded.

## 2. Map mcp_servers to twins

Call `list_twins` (Pome control MCP) for the live twin list — never assume it. Map each
`mcp_servers[].name` to a twin id by name and URL (`github`/a GitHub MCP URL → twin
`github`). A server with no matching twin is **uncovered**: tasks cannot exercise it,
and the examinee clone will not carry it. Do not guess a mapping.

## 3. Register with `intake_clone_scope`

One call per agent (idempotent on slug; re-intake updates the scope):

- `slug` — kebab-case of the agent name, stable across re-intakes.
- `display_name` — the agent's name as-is.
- `mcp_servers` — **covered servers only**, `[{name, twin}]`. `name` is the examinee's
  ORIGINAL server name, unchanged (`github`, never `pome-github`).
- `env_packages` — the environment config's packages, copied verbatim.
- `memory_policy` — one line per attached store: id, access mode, and
  `"snapshot-clone per run; never attach the original"`.
- `initial_events` — the deployment's `initial_events`, verbatim.

If **zero** servers are covered, still register (`slug` + `display_name`, no
`mcp_servers`) so the agent exists on the platform, and say so in the report.

## 4. Report

End with exactly this shape:

```
## Pome intake: <display_name>

Model: <model from YAML> · Runtime: <Claude managed agent | self-hosted via <transport>>

| mcp_server | url | twin | coverage |
|---|---|---|---|
| github | <original url> | github | ✅ covered |
| sentry | <original url> | — | ❌ no twin yet |

Covered N of M servers.


⚠ D9 — memory: production memory stores are never attached to the examinee.
Pome snapshot-clones each store into a per-run test store (attach defaults to
read_write — a test run would write fiction into production memory). After the
run the snapshot is graded as evidence: "did it record what it should?"

⚠ D10 — closed-book exam: web_search and web_fetch are disabled on the
examinee. They egress through Anthropic infra past the network clamp — an
untaped exfiltration channel during injection tests, and live internet content
would contradict the seeded world. (F-770)

Next: author tasks against the covered twins (Skill 1). At run time the
launch path forks on the Runtime line above: Claude managed agent → Anthropic's
Managed Agents cloud; anything else → the REST path (rest_urls). Launching a
non-Claude examinee on Managed Agents swaps its model for Claude and tests
nothing.
```

Both warnings appear in **every** report, even with no memory store or web tool in
sight — they describe how the examinee will be run, not a defect in the agent.
One conditional line, added only when it applies:

- **Any server uncovered** → after the count: `<names>: tasks cannot test work
  that touches these servers until a twin ships.`
