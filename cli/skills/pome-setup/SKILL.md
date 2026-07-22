---
name: pome-setup
description: Use when wiring a repository's coding agent to pome so pome can run it against deterministic SaaS twins (GitHub, Stripe, Slack) — first-time setup, after the agent's third-party services change, when `pome doctor` reports the repo unwired, or when a `pome install` session hands off to you. Triggers on "wire my agent to pome", "set up pome", "make this repo pome-ready", or "/pome-setup".
---

# pome-setup

Wire an existing coding agent's repository to pome (`https://pome.sh`), adapter-first, and prove the wiring with `pome doctor`. The job is not done until doctor exits green.

Pome runs agents against deterministic SaaS twins — local, resettable copies of the GitHub/Stripe/Slack APIs — and records every tool call as a trace. The OSS CLI is capture-only: a local run (`pome run --local`) records a raw trace and never scores; verdicts come from Pome cloud (`pome eval <run-dir>` on a captured trace, or a hosted `pome run`).

Wiring changes nothing about production behavior: the adapter only emits trace signals during a pome run, and twin base URLs come from env vars the pome runner injects at run time.

## Hard rules

Follow these on every step. They are not optional.

1. **Never write secrets into source, config, or chat.** No API keys, tokens, or credential values in any file you edit or any message you print. The pome runner injects `POME_*` env vars at run time; read them, never inline their values.
2. **Read every file immediately before you write it**, even if you already read it earlier in the session. Stale edits break repos.
3. **Minimal, targeted edits.** Change what the wiring requires and nothing else — no refactors, no reformatting, no drive-by fixes.
4. **Show the diff and get explicit user approval before applying any edit.** If your harness has an edit-approval UI, that gate counts. If it doesn't, print the proposed change in chat and wait for a yes.
5. **Never weaken the capture layer.** Don't remove `withPome()`, don't add `*` to `POME_EGRESS_ALLOW`, don't route around the twin.
6. **No production-host literals in agent source.** `pome doctor` treats a hardcoded `https://api.github.com` — even as a `??` fallback — as a twin bypass and fails. Production fallbacks belong in deployment env, not in source literals. (Loopback fallbacks like `http://127.0.0.1:3333` are fine.)
7. **Don't guess service coverage.** If the agent talks to a service pome has no twin for, say so explicitly and skip that service — never fake wiring.
8. **Finish with `pome doctor` and iterate until green.** Never report success while any check is red.

## Steps

### 0. Preflight

```bash
pome version
```

If the command is missing, install it (`npm install -g @pome-sh/cli`), then continue.

Auth — any one of these passing is enough (the macOS Keychain item is service `sh.pome.cli`, account `hosted`):

```bash
security find-generic-password -s "sh.pome.cli" -a hosted -w >/dev/null 2>&1 \
  || test -f ~/.pome/credentials.json \
  || [ -n "$POME_API_KEY" ] \
  && echo ok
```

If this does not print `ok`, run `pome login` (opens a browser; stores credentials in the macOS Keychain, or `~/.pome/credentials.json` on other platforms). When a `pome install` session handed off to you, auth was already checked — the probe just confirms instantly.

### 1. Identify the agent and its services

Read the repo (`package.json` / `pyproject.toml` / agent source / README) and establish three things:

- **Entrypoint + start command** — the exact command that starts the agent (e.g. `npm run src/index.ts`).
- **Framework** — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), another SDK, or a custom script driving an LLM.
- **Services** — which third-party APIs the agent calls (GitHub? Stripe? Slack?). Run `pome scenarios` to see which twins exist.

**Pause: confirm the agent and its services with the user in one short message** before touching anything. Misidentified services produce irrelevant wiring.

### 2. Ensure pome.config.json

```bash
test -f pome.config.json && echo ready || echo "needs pome init"
```

If absent, tell the user `pome init` will scaffold `pome.config.json`, `scenarios/`, and example agents — after they confirm, run it.

Then set `agent.command` in `pome.config.json` to the real start command from step 1. The scaffold default runs a bundled example, not the user's agent. Show the line you set; confirm before moving on.

### 3. Wire the adapter (Claude Agent SDK repos)

For repos built on `@anthropic-ai/claude-agent-sdk`:

1. Add the dependency, matching the repo's package manager (lockfile tells you): `npm install @pome-sh/adapter-claude-sdk`.
2. Swap imports — `query` and `tool` come from the adapter as drop-in replacements; `createSdkMcpServer` and everything else stay on the SDK:

   ```ts
   import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";
   import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
   ```

3. Call `withPome()` once at agent startup, before any requests are made. It hooks `fetch` to emit trace signals and correlation headers — only during a pome run.

For other stacks there is no adapter yet: wiring is step 4 alone, and the trace comes from the twin side. Say so explicitly in the confirmation message.

### 4. Route requests through the env pome injects

Find every place the agent reaches a twinned service and read the base URL from env instead of a literal:

```ts
// twin URL + token injected by the pome runner — never production
const { POME_GITHUB_REST_URL: baseUrl, POME_AUTH_TOKEN: token } = process.env;
```

| Env var | What the runner injects |
| --- | --- |
| `POME_<SERVICE>_REST_URL` | REST base URL of that service's twin (e.g. `POME_GITHUB_REST_URL`) |
| `POME_<SERVICE>_MCP_URL` | MCP endpoint of that twin |
| `POME_AUTH_TOKEN` | Bearer token for the twin session |
| `POME_TASK` | The task's prompt |

Remove hardcoded production hosts entirely (hard rule 6).

### 5. Verify: pome doctor to green

```bash
pome doctor
```

Doctor runs four checks in order — config → twin reachable → routing → egress floor — and stops at the first failure with ONE named cause (file:line where knowable) and ONE concrete fix. Apply the minimal fix (hard rules 2–4 still apply) and re-run. Loop until it ends green:

```
✓ pome.config.json found
✓ twin reachable  github · local
✓ requests route to the twin  reads POME_GITHUB_REST_URL
✓ egress floor active  deny-by-default · N pattern(s) + loopback
```

### 6. Print next steps — don't run them

End the session by printing exactly this shape (substitute the twin and task):

```
wiring verified — pome doctor is green.

next steps:
  pome scenarios github --copy               # pull runnable tasks into ./scenarios/
  pome run scenarios/01-bug-happy-path.md    # 5 isolated trials against the twin
  pome register agent <name>                 # optional: group dashboard runs under one agent
```

## Common pitfalls

| Symptom | Fix |
| --- | --- |
| `npm install @pome-sh/adapter-claude-sdk` fails | Confirm registry access (`npm view @pome-sh/adapter-claude-sdk version`). Inside a pome-twins checkout you can also pin `"@pome-sh/adapter-claude-sdk": "file:<checkout>/packages/adapter-claude-sdk"` while iterating on unpublished workspace changes. |
| doctor: "reads from a hardcoded https://api.github.com" | A production-host literal survives in agent source — even a `?? "https://api.github.com"` fallback triggers it. Move the fallback out of source; read `POME_GITHUB_REST_URL`. |
| doctor: "twin not reachable" | Twin dependencies missing — run the repo's install (`npm install` / `npm install`) and re-run `pome doctor`. |
| doctor: "egress floor disabled" | Remove `*` from `POME_EGRESS_ALLOW`. Never widen egress to pass a check. |
| Hosted commands fail 401/403 | Re-run `pome login` (or set `POME_API_KEY` in CI). |
| `agent.command` is still the scaffold default | Point it at the user's real agent (step 1's start command); the default runs a bundled example. |
| The agent talks to a service with no twin | Name it in the confirmation message and skip it (hard rule 7). The user can request the twin from pome. |

## Output contract

When this skill finishes successfully:

- `pome.config.json` exists with a real `agent.command`.
- Claude Agent SDK repos: `@pome-sh/adapter-claude-sdk` resolves and `withPome()` runs at startup.
- No hardcoded production hosts remain in agent source; twinned-service base URLs are read from `POME_*` env.
- `pome doctor` exits green — all four checks.
- The session ends with the next-steps block printed, not executed.
