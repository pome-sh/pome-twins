# Launcher — Claude managed agent (Skill 4 reference)

The runtime-specific seam for a **Claude managed agent** examinee
(`examinee_launch.transport: "mcp"`): assemble the clone on Anthropic's Managed
Agents cloud with the `ant` CLI, start it on the kickoff task, watch for idle,
then return to SKILL.md §3 to `finalize_run` while the twin session is still
live. Adding a platform means adding a sibling file like this one — never editing
the pipeline (ADR-018).

Field names below are verbatim from `run_task`'s `examinee_launch` (Tool
Contract v0.3, as-shipped); where this prose and the live spec disagree, the spec
wins. Exact `ant` flags come from `ant --help` / the Managed Agents docs — this
reference fixes the **mapping and the order**, not CLI syntax.

Requires `ant` authenticated (`brew install anthropics/tap/ant && ant auth
login`; `ant auth login` is F-782). No `ant` → you cannot launch a managed-agent
examinee; either authenticate or run the examinee yourself and use the REST path.

## The spec drives everything — map it, don't invent it

| `examinee_launch` field | Becomes, on Managed Agents |
| --- | --- |
| `network: { mode: "limited", allowed_hosts }` | the **environment**'s network clamp: limited egress, `allowed_hosts` copied verbatim (only the twin host) |
| `env_packages` | the environment's packages, verbatim |
| `mcp_servers[]` `{ name, url, bearer }` | one **mcp_toolset** per entry — `mcp_server_name` = `name`, server `url` = `url` (the per-session twin route, unchanged) |
| `mcp_permission_policy: { type: "always_allow" }` | `permission_policy` on **every** mcp_toolset (see below — this is not optional) |
| `known_network_clamp_bypass` / `hermetic: false` | **disable `web_search` and `web_fetch`** on the agent — closed-book (D10). They egress past the clamp untaped; the spec flags that they are *not* auto-stripped, so you strip them |
| `mcp_servers[].bearer` (= `agent_token`) | a **vault** `static_bearer` credential bound to each twin URL — SENSITIVE, lives in the vault, never inline in the agent def and never on disk |
| `memory_policy` + `initial_events` | memory store attached as a **snapshot-clone per run** (D9 — never the production store); `initial_events` become the session's `initial_events`, verbatim |
| `instructions` | the coach's assembly instructions — follow them; they restate always_allow / closed-book so a drifting reader still gets it right |

Model comes from intake (the agent's real model, e.g. `opus-4-8`), not from the
spec. `examinee_task.prompt` is the kickoff message.

## Assembly order

1. **Environment** — `ant beta:environments create`: `network.mode: limited`,
   `allowed_hosts` = `examinee_launch.network.allowed_hosts`, packages =
   `env_packages`. Pome already computed the clamp; you copy it.
2. **Vault** — create `static_bearer` credentials, one per twin URL, value =
   that server's `bearer`. Bind by URL so each mcp_toolset resolves its own
   token. The bearer never appears in the agent definition or a file.
3. **Agent clone** — `ant beta:agents create`: the intake model; one
   `mcp_toolset` per `mcp_servers[]` entry with `permission_policy` set to
   `examinee_launch.mcp_permission_policy` (`always_allow`); the vault attached;
   `web_search` and `web_fetch` **removed**; memory as a snapshot-clone.
4. **Session** — `ant beta:sessions create` on the agent + environment, with
   `initial_events` verbatim and the kickoff task = `examinee_task.prompt`.

## always_allow is load-bearing (F-787)

Managed Agents defaults a minimal `mcp_toolset` to **ask-for-permission**. A
headless coach never sends `user.tool_confirmation`, so an examinee without
`always_allow` deadlocks on its *first* MCP call — the session idles in
`requires_action` and scores nothing. `examinee_launch.mcp_permission_policy`
now carries `always_allow` exactly so this cannot happen; apply it to **every**
toolset. If you inherit a session already stuck in `requires_action` on tool
confirmation, recover with `sessions.update` → `always_allow` plus one
`tool_confirmation` to release the pending call, then let it run — but the
supported path is to set it up front.

## Detect idle → finalize immediately

Poll the session (`ant beta:sessions retrieve --session-id <sid>`). Idle =
the examinee has finished the kickoff task and is emitting no further tool calls
(terminal/completed, or awaiting input with nothing more coming). The moment it
idles, **stop polling and go to SKILL.md §3** — `finalize_run(session_id,
agent_token)` on the **Pome** `session_id` (not the `ant` session id), while the
twin sandbox is still up. Do not tear the `ant` session down first: if the twin
session expires or is finalized-too-late, the tape is gone. `finalize_run` pulls
the tape and scores; only then is the managed-agent session safe to discard.
