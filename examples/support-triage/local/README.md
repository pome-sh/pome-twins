# support-triage — local examinee

The hero example's **local examinee**: the same support-triage agent as
[`../agents/support-triage-v1.yaml`](../agents/support-triage-v1.yaml), but as a
minimal [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript)
process that runs on **your** machine instead of on a managed-agent platform. It
connects to Pome's GitHub + Slack twins over plain MCP (bearer-authenticated
streamable HTTP), works the task, and exits when done.

The exam it takes is the pack's task,
[`../scenarios/duplicate-issue.md`](../scenarios/duplicate-issue.md): a customer
re-reports a bug that open issue #1 already tracks.

## The fix ("33, not 0")

The whole product story is **one line** of the system prompt — `TRIAGE_RULE` in
[`src/index.ts`](./src/index.ts):

- **v1 (ships as the default — fails).** The baseline line tells the agent
  *not* to search existing issues, so it files a **duplicate** issue for a bug
  already tracked. It scores **33, not 0**: the agent does real work (its
  report has concrete repro steps), but flunks both duplicate-detection
  criteria — exactly the failure a happy-path demo never shows.
- **v2 (the one-line fix — passes).** Swap `TRIAGE_RULE` to the commented
  `TRIAGE_RULE_V2` right next to it (*search open issues first; comment on the
  existing issue instead of opening a second one*), re-run, and the same exam
  goes green.

The two lines are verbatim from `../agents/support-triage-v1.yaml` and
`…-v2.yaml` — this examinee and the managed-agent pair tell the same
fail → fix → pass story on different runtimes.

## How the coach launches it

This folder is built to be spawned as a **local subprocess** by the coach
(the agent driving the Pome control MCP at `mcp.pome.sh`):

1. **Fetch just this folder** onto the builder's machine:

   ```bash
   npx degit pome-sh/digital-twins/examples/support-triage/local support-triage-local
   cd support-triage-local && npm install
   ```

2. **Mint the run** — `run_task(task_id, agent_id)` seeds live twin sandboxes
   and returns `examinee_task` (the kickoff prompt) and `examinee_launch`
   (per-twin MCP URLs + the session bearer).

3. **Spawn with the env contract** — map the spec onto the env and start the
   process:

   | env var | from `run_task` |
   | --- | --- |
   | `POME_GITHUB_MCP_URL` | `examinee_launch` — the GitHub twin's per-session MCP URL |
   | `POME_SLACK_MCP_URL` | `examinee_launch` — the Slack twin's per-session MCP URL |
   | `POME_AUTH_TOKEN` | `agent_token` — the session bearer for **both** twins. **Sensitive**: env-inject only, never write it to disk |
   | `POME_TASK` | `examinee_task.prompt` (optional — the bundled kickoff prompt is the fallback) |

   ```bash
   POME_GITHUB_MCP_URL=… POME_SLACK_MCP_URL=… POME_AUTH_TOKEN=… POME_TASK=… npm run start
   ```

4. **Finalize on exit** — the process exits when the agent is done; the coach
   calls `finalize_run(session_id, agent_token)` the instant it does, while the
   twin session is still live, then narrates `get_report`.

The same env contract is what the Pome CLI injects, so the local loop also
works without the coach — from this directory, with the CLI at `../../../cli`:

```bash
npm run --cwd ../../../cli dev -- run ../examples/support-triage/scenarios/duplicate-issue.md \
  --agent "npm run --cwd $(pwd) start"
```

## Zero-key Claude auth

The Agent SDK needs Claude auth, nothing else:

- a **stored `claude` login** on this machine (subscription — no env var at
  all), or
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or
- `ANTHROPIC_API_KEY` as the BYOK fallback.

The twin side is zero-key by construction: the only credential is the
per-session bearer the runner injects as `POME_AUTH_TOKEN`.

## Layout

```
src/index.ts       the examinee — env wiring, the TRIAGE_RULE v1/v2 pair, the SDK loop
test/env.test.ts   unit test for the launch env contract (npm test)
```

`npm run typecheck` type-checks; `npm test` runs the env-contract test. This
package is intentionally **not** part of the root npm workspace — install and
run it standalone.
