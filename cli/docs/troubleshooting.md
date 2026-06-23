---
title: "Troubleshooting"
description: "When a run is not green."
---

Start with `pome inspect latest`. It usually points at the layer that failed: scenario, agent, twin, or judge.

## Agent crashed

```bash
open runs/<scenario>/<run-id>/stderr.log
```

Most common causes:

- Agent did not no-op on `POME_PREFLIGHT=1`.
- Agent ignored `POME_GITHUB_REST_URL` and hit the real internet.
- Scenario prompt referenced state the agent could not parse.

## Score below 100

```bash
open runs/<scenario>/<run-id>/events.jsonl
open runs/<scenario>/<run-id>/state_final.json
```

If a call has `fidelity: "unsupported"`, the agent reached for an endpoint the twin does not implement yet. File an issue at [github.com/pome-sh/pome](https://github.com/pome-sh/pome/issues).

## Twin will not start

A port is stuck:

```bash
pome twin reset
pome twin start github --port 3334
```

To check whether the twin process is alive, hit the unauthenticated root health endpoint:

```bash
curl http://127.0.0.1:3333/healthz
```

The session-scoped `/s/<sid>/healthz` requires the JWT and returns 401 without it.

## Hosted run hangs or 401s

Re-mint your key:

```bash
pome login
```

Or set `POME_API_KEY` directly in CI.

## `events.jsonl uses the legacy single-shape RecorderEvent schema`

The hosted upload now requires the FDRS-398 discriminated-union schema. Upgrade the CLI:

```bash
npm install -g pome-sh@latest
```

Then re-run.

## `pome fix-prompt` says "no failures" for a failed hosted run

Hosted runs do not yet surface per-criterion verdicts to the CLI. If you see the message `verdicts not available, open cloud run URL, or re-run POME_LOCAL=1 to enable local judge`, do one of:

- Open the run URL printed by `pome run` and read the judge feedback in the dashboard.
- Re-run with `POME_LOCAL=1 pome run <scenario>` to use the local judge, which writes per-criterion verdicts to disk.

The cloud-side fix is in flight.

## `pome login` says "already logged in" but I do not see `~/.pome/credentials.json`

On macOS, pome stores the key in the Keychain by default:

```bash
security find-generic-password -s "pome-sh" -w
```

On Linux/Windows, or when the Keychain is unavailable, the key falls back to `~/.pome/credentials.json`. Both paths are valid; the CLI tries the env var, then the Keychain, then the JSON file.

## `pome run` exits 2 or 3 when you expected 1

Stage 1 has known regressions in a few exit-code paths. A sub-threshold hosted run can return exit code 2 or 3 instead of the documented 1; a failing pre-flight (missing scenario file, logged-out state) can also return 2 instead of 5 or 3. The documented contract in [CLI reference](/docs/cli#exit-codes) is the intent. The audit and regression tests land under launch readiness item L8.

If your CI branches on `$?`, treat exit codes as advisory until L8 closes. The dashboard run URL is the source of truth for pass/fail.

## `pome run --api-url http://...` does not change the destination

The `--api-url` flag is currently dropped on the way to the hosted client. Use the env var as a workaround:

```bash
POME_API_URL=http://127.0.0.1:9999 pome run scenarios/<file>.md
```

The flag will be fixed in a follow-up release.

## `pome session list` returns more rows than the dashboard

The CLI defaults to `--state running`, but if you have ever passed `--state all`, that selection persists in your shell history. The dashboard's Twins page defaults to running sessions. To match it:

```bash
pome session list                       # defaults to --state running
pome session list --state done          # only finished sessions
pome session list --state expired       # only expired
pome session list --state all           # everything
```

## `pome session create` prints two identical URLs and my agent's MCP transport fails

Hosted session text output currently prints the `MCP` URL without the `/mcp` suffix, so it looks identical to the REST `API` URL. An agent that mounts that URL as an MCP transport gets REST responses and fails to negotiate the handshake.

Workaround: append `/mcp` to the printed URL when configuring your agent. Tracked as F19.

```text
# what's printed:
API: https://session-...pome.sh/s/ses_abc
MCP: https://session-...pome.sh/s/ses_abc

# what your agent needs:
MCP: https://session-...pome.sh/s/ses_abc/mcp
```

The standalone `pome twin start github` path emits the suffix correctly.

## `pome compile-seeds --hosted` fails with a `vercel.com/d?to=...` URL

The hosted seed compiler hit a temporary capacity limit. Retry, or compile locally with your own Anthropic key:

```bash
pome compile-seeds --force
```

The `--force` path uses your `ANTHROPIC_API_KEY` directly and is not subject to hosted quota.
