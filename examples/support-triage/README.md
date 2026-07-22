# support-triage — a self-fix demo on Pome

A minimal **support-triage agent** for the `acme` engineering org: it watches the
`#support` Slack channel for bug reports, reproduces them, tracks each as a GitHub
issue in `acme/orders-service`, and posts the tracking link back to `#support`.
Two twins in one run — the **Slack twin** (where the report arrives) and the
**GitHub twin** (where the issue lives).

The pack exists to demo a reproducible **FAIL → FIX → PASS** on Pome using two
versions of the agent that differ by exactly **one line**:

- `agents/support-triage-v1.yaml` — **baseline**. Its charter tells the agent
  *not* to search existing issues. On a re-reported bug it files a **duplicate**
  issue. **Fails.**
- `agents/support-triage-v2.yaml` — **fixed**. The one line is replaced by a
  *search-before-filing* rule, so it comments on the existing issue instead of
  opening a second one. **Passes.**

```bash
diff agents/support-triage-v1.yaml agents/support-triage-v2.yaml   # one line
```

The failure — filing a duplicate issue for a bug that's already tracked — is the
kind of thing a happy-path demo never shows and an issue tracker hates at scale.
Pome catches it by grading the twin's real end state: `issues: 1 → 2` (a
duplicate) for v1 vs `issues: 1 → 1` + a comment for v2. Measured results are in
[`VERIFICATION.md`](./VERIFICATION.md) (v1 **0/5**, v2 **4/5** on
`claude-sonnet-5`).

## The task

[`tasks/duplicate-issue.md`](./tasks/duplicate-issue.md) is
self-contained (task + criteria + an inline `## Seed State`). The seed pre-loads
open issue #1 for the coupon bug, then `#support` receives a *new* report of the
*same* bug. A good agent recognizes the duplicate.

| criterion | kind | checks |
|---|---|---|
| a `#support` message links `issues/1` | code:slack | the agent linked the *existing* issue, not a new one |
| recognized the existing issue, opened no duplicate | model | the dedup decision |
| concrete repro steps | model | quality of the tracked report |

## Run it against Pome

The two versions are exercised as **two distinct agents** end-to-end, so the
dashboard shows two separate identities with separate scores.

1. **Register on Cloud Managed Agents** — create each agent from its YAML on
   Anthropic's Managed Agents platform (`ant beta:agents create`, model
   `claude-sonnet-5`).
2. **Register on Pome** (control MCP) — one call per version, so each accrues its
   own history:
   ```
   register_agent(name="support-triage-v1", twins=["github","slack"])
   register_agent(name="support-triage-v2", twins=["github","slack"])
   ```
3. **Run** — for each agent id, `run_trials(scenario_id, agent_id, n=5)`. Each
   trial returns an `examinee_launch` spec (per-session twin MCP URLs, a bearer,
   `always_allow`, a `network.mode: limited` clamp, web tools off). Assemble the
   examinee clone from that spec (mirrors
   `pome-run-scenario/references/launch-managed-agent.md`), give it
   `examinee_task.prompt`, and let it work.
4. **Finalize** — `finalize_run(session_id, agent_token)` the instant the
   examinee idles (the tape is pulled from the still-live twin session), then
   `get_report` for the score. Tear the clone down afterward — clones are
   ephemeral, one per trial.

The self-fix loop is the swap between step 3's two agents: run v1 → watch it fail
by filing a duplicate → switch to v2 (the one-line fix) → watch it pass.

## Local examinee

[`local/`](./local/) is the same agent as a minimal **Claude Agent SDK process
on your machine** — no managed-agent platform needed. The coach spawns it as a
subprocess after `run_task` (per-twin MCP URLs + bearer arrive via env), it
works the task over MCP, and exits when done. The v1/v2 one-liner lives as a
prompt constant in its code: v1 ships as the default, the fix is a one-line
swap. See [`local/README.md`](./local/README.md).

## Layout

```
agents/support-triage-v1.yaml   baseline (files a duplicate) — fails
agents/support-triage-v2.yaml   fixed (searches first) — passes; one line different
tasks/duplicate-issue.md        the task (inline ## Seed State)
local/                          the same agent as a local Claude Agent SDK examinee
VERIFICATION.md                 measured v1-vs-v2 results with run ids
```

## Notes

- The bearer token in each `examinee_launch` is **sensitive** — keep it in memory
  only; never write it to disk or into a task.
- The declared `mcp_servers` URLs (`mcp.slack.com`, `api.githubcopilot.com`) are
  the agent's *real* servers; Pome swaps them for per-session twin URLs at run
  time. Do not intake `support-triage-v1` against a real deployment — it files
  duplicates by design.
