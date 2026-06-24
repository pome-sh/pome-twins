# Pome CLI

The `pome` command runs AI-agent scenarios against resettable hosted twins,
records tool calls, and scores the result.

## CLI Installation

Install the `pome` command first. Until the first npm registry release ships,
install from the GitHub source checkout.

```bash
git clone --depth 1 https://github.com/pome-sh/pome.git
cd pome/cli
npm install
npm install -g .
pome --help
```

Run the local `npm install` before `npm install -g .` so the `prepare` build has
the TypeScript dependencies it needs.

If you prefer Bun:

```bash
bun install
bun run build
npm link
```

Smoke test:

```bash
pome --help
```

You should see commands such as `init`, `login`, `register`, `session`, `run`,
`inspect`, and `docs`.

### Install from npm registry

_Not available yet._ Registry install instructions will be documented here once
the first package release ships. Until then, install from GitHub.

## First-Time Setup

After the CLI is installed, set up your account and the project directory where
you want Pome scenarios and run artifacts to live.

```bash
pome login
pome init
```

`pome login` opens the browser and stores a local API key. `pome init` creates
starter folders such as `scenarios/`, `examples/agents/`, `runs/`, plus
`pome.config.json` in the current directory.

To verify hosted twins are reachable:

```bash
pome session create --twin github
pome session list
```

Open **Twins** on [app.pome.sh](https://app.pome.sh) to see the same session.
Use `pome session stop <session-id>` when you are done.

For narrative docs, run `pome docs getting-started` to print the canonical
`docs.pome.sh` URL. `pome --help` and `pome help <command>` show CLI reference
details.

## Local development (this repository)

```bash
bun install
bun run build
bun run pome -- health
```

## Quickstart

```bash
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

Print stable `docs.pome.sh` URLs for Mintlify narrative docs. The authored docs live in the `pome` repo; this package keeps only topic metadata for lookup.

```bash
pome docs
pome docs getting-started
pome docs github --url
```

Use `pome --help` for command reference and `pome docs [topic]` for the corresponding web docs URL.

### `pome session create|list|stop`

Hosted sandbox sessions (same API as the dashboard Twins page). Requires `pome login` or `POME_API_KEY`.

```bash
pome session create --twin github
pome session create --twin stripe --format json
pome session create --twin stripe --format env --secrets-file .pome-session.env
pome session list
pome session stop ses_...
```

Secrets (`agent_token`, provider keys) are never printed to stdout/stderr. Use `--secrets-file <path>` to write shell exports to a local file with mode **0600**. `--format json` is intended for automation and stays redacted.

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
