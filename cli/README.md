# Pome CLI

The `pome` command runs AI-agent scenarios against resettable hosted twins,
records tool calls, and scores the result.

## Install (GitHub — primary)

V1 ships from the public repo until an npm release is published (see below). The CLI lives at `cli/` inside the `pome-sh/pome` monorepo.

```bash
git clone --depth 1 https://github.com/pome-sh/pome.git
cd pome/cli
npm install            # install local dev deps so `prepare` can build
npm install -g .       # global install runs `prepare` (tsc + copy-prompts)
pome --help
```

The first `npm install` is required: `npm install -g .` runs the `prepare` hook (which calls `tsc`), and on a fresh clone `cli/node_modules/` is empty, so `tsc` cannot resolve `@types/node`, `zod`, `node:crypto`, etc. and aborts with hundreds of TS2580 / TS2307 errors. The local install populates `cli/node_modules/` first.

If your environment is bun-friendly, this is equivalent and slightly faster:

```bash
bun install
bun run build
npm link               # symlink the built dist/ to a global `pome`
```

**Smoke (clean machine):** install as above → `pome --help` shows `init`, `login`, `register`, `session`, `run`, `inspect`, `docs`.

### Install from npm registry

_Not available yet._ `pome-sh` on npm (or another scope) will be documented here once the first registry release ships. Until then, use the GitHub install line.

## Hosted in 60 seconds

```bash
pome login
pome session create --twin github
```

Then open **Twins** on [app.pome.sh](https://app.pome.sh) — the session row should match the id from the CLI. Use `pome session list` and `pome session stop <session-id>` to manage sandboxes.

For narrative docs, run `pome docs getting-started` (renders the page in your terminal from bundled Mintlify sources and shows the `docs.pome.sh` URL). `pome --help` / `pome help` list subcommands; see `docs/HELP-SURFACES.md` for how those surfaces relate.

## Local development (this repository)

```bash
bun install
bun run build
bun run pome -- health
```

## Quickstart

```bash
pome login
pome init
pome register agent my-agent
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome inspect latest
```

`pome init` creates `scenarios/`, `examples/agents/`, `runs/`, starter scenarios, and `pome.config.json` when missing. Run `pome init` in each project that should own its own scenarios and artifacts. Runs record to `app.pome.sh/agents/<your-agent>` automatically.

For the Stripe twin, pair `scenarios/14-stripe-refund-retry.md` with the LLM-driven refund agent (needs `ANTHROPIC_API_KEY`):

```bash
pome run scenarios/14-stripe-refund-retry.md --agent "npx tsx examples/agents/llm-refund-agent.ts"
```

## Commands

### `pome init`

Create starter folders and `pome.config.json` in the current directory.

```bash
pome init
```

### `pome login`

Sign in with Clerk in the browser and store a team API key (`pme_…`). On macOS
the default is **Keychain**; elsewhere (or when Keychain is unavailable) credentials go to `~/.pome/credentials.json` with mode **0600**.

```bash
pome login
pome login --dashboard-url https://app.pome.sh --api-url https://api.pome.sh --key-name "laptop"
```

The dashboard must serve **`/cli/login`** (loopback `redirect_uri` + `state` query params). The CLI exchanges the one-time `code` at `POST /v1/auth/cli/exchange` on the control plane.

Options:

- `--api-url <url>`: control-plane base URL (default `https://api.pome.sh`).
- `--dashboard-url <url>`: app URL for Clerk (default `https://app.pome.sh`).
- `--key-name <name>`: label for the minted API key.

### `pome logout`

Remove locally stored credentials (Keychain item and/or credentials file). API keys are **not** revoked server-side — revoke from the dashboard if needed.

```bash
pome logout
```

### `pome scenarios [twin]`

Browse the bundled scenarios library, or copy a twin's runnable scenarios into the current project.

```bash
pome scenarios                       # list available twins
pome scenarios github                # list github scenarios + descriptions
pome scenarios github --copy         # copy into ./scenarios/ (skips files that already exist)
pome scenarios github --copy --force # overwrite existing files
pome scenarios github --copy --dest custom-dir
```

The same catalog drives `pome init` — running `pome scenarios github --copy` after `pome init` is a safe no-op unless `--force` is passed.

### `pome docs [topic]`

Read Mintlify narrative docs **in the terminal** (Markdown/MDX shipped inside the package) with optional section navigation on a TTY, or print stable `docs.pome.sh` URLs. Sources are indexed in `src/cli/docs-topics.ts` — the CLI does not scrape the website.

```bash
pome docs
pome docs getting-started
pome docs github --url
```

See `docs/HELP-SURFACES.md` for how `pome docs` relates to `pome --help`. Set `NO_COLOR=1` for plain output.

### `pome session create|list|stop`

Hosted sandbox sessions (same API as the dashboard Twins page). Requires `pome login` or `POME_API_KEY`.

```bash
pome session create --twin github
pome session create --twin stripe --format json
pome session list
pome session stop ses_...
```

Secrets (`agent_token`, provider keys) are **redacted** by default. Use `--show-secrets` and/or `--format env` only on trusted terminals. `--format json` is intended for automation (`NO_COLOR` / non-TTY friendly).

### `pome run <path>`

Run one scenario markdown file, or every `.md` scenario in a directory.

```bash
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome run scenarios/ --agent "node ./dist/agent.js"
```

Runs hit the hosted control plane by default and record to `app.pome.sh`. Requires `pome login` (or `POME_API_KEY=pme_...`) before first use.

Options:

- `--agent <command>`: command to run as the agent.
- `--artifacts-dir <dir>`: directory for run artifacts. Defaults to `runs`.
- `--api-url <url>`: override control-plane URL.
- `--agent-model <name>`: informational model name recorded on the cloud run.
- `--no-fix-prompt`: skip CLI-side LLM fix-prompt generation.
- `--hosted`: deprecated no-op; hosted is now the default. The flag will be removed in a future release.

During a run, Pome injects environment variables into the agent process, including `POME_TASK`, `POME_GITHUB_*`, `POME_STRIPE_*`, `POME_AUTH_TOKEN`, `POME_RUN_ID`, and `POME_ARTIFACTS_DIR`.

Artifacts live under `runs/<scenario>/<run-id>/` (`events.jsonl`, `score.json`, state snapshots, etc.). A legacy `tool_calls.jsonl` view of the same data is also written for back-compat.

### `pome inspect <run|latest>`

Print a human-readable report for a run.

```bash
pome inspect latest
pome inspect runs/01-bug-happy-path/<run-id>
pome inspect latest --artifacts-dir runs
```

### `pome fix-prompt <events.jsonl> <score.json> <scenario.md>`

Generate a paste-into-IDE fix prompt (BYOK — your LLM endpoint).

```bash
export POME_LLM_BASE_URL=https://openrouter.ai/api/v1
export POME_LLM_API_KEY=...
export POME_LLM_MODEL=anthropic/claude-haiku-4.5
pome fix-prompt runs/demo/events.jsonl runs/demo/score.json scenarios/demo.md
```

### `pome twin start <name>`

Start a standalone local twin (`github` today).

```bash
pome twin start github --port 3333
```

### `pome twin reset` / `pome twin status`

Reset or print standalone twin status.

### `pome endpoints <name>`

List supported endpoints for a twin.

```bash
pome endpoints github
```

### `pome version` / `pome health`

```bash
pome version
pome health
```

## Authentication

```bash
pome login
pome run scenarios/01-bug-happy-path.md
```

Or set `POME_API_KEY=pme_...` for CI.

## Exit codes

- `0`: success / all scenarios passed threshold.
- `1`: scenario below threshold or partial failure.
- `2`: invalid input, parse error, hosted client error.
- `3`: hosted auth, session, or agent timeout failure (where applicable).

## Development

```bash
bun install
bun run typecheck
bun run build
bun run test
```

The package publishes the `pome` binary from `dist/src/cli/main.js`.
`prepublishOnly` runs the build before `npm publish`.

### Versioning — every behavior change ships with a bump

Any PR that touches `cli/src/**` must either add a changeset under
`cli/.changeset/` or bump `cli/package.json` directly; CI enforces this
via [`scripts/check-cli-version-bump.sh`](../scripts/check-cli-version-bump.sh).
Preferred path: `cd cli && bun changeset` (writes a markdown entry recording
patch / minor / major + a one-line summary). At release time, `bun changeset
version` consumes pending entries to bump `cli/package.json` and update
`CHANGELOG.md`, and `bun changeset publish` ships to npm. The gate exists
because PR #93 shipped five fixes without a bump and a downstream user lost
~1h debugging whether `pome --version` reflected the new code.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
