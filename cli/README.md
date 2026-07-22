# Pome CLI

The `pome` command runs AI-agent tasks against resettable digital twins of
real SaaS APIs (GitHub, Stripe, …), captures the trace, and gets a verdict from
Pome cloud.

The CLI is **capture-only**: it records raw traces and never scores, judges, or
correlates locally. A verdict comes only from the cloud — a hosted `pome run`
prints it to the terminal and records it to the dashboard, and
`pome eval <run-dir>` uploads a captured trace for a cloud verdict.

**📚 Full documentation lives at [docs.pome.sh](https://docs.pome.sh).**
Run `pome --help` (or `pome help <command>`) for the CLI reference, and
`pome docs getting-started` to open the canonical quickstart.

## Install

```bash
npm install -g @pome-sh/cli
pome --help
```

Or run it without installing: `npx @pome-sh/cli <command>` — e.g.
`npx @pome-sh/cli twin start github` boots a local GitHub twin with nothing
but Node ≥ 24.

Gmail is first-party too:

```bash
npx @pome-sh/cli twin start gmail --port 3336
# prints POME_GMAIL_REST_URL, POME_GMAIL_MCP_URL, and POME_GMAIL_TOKEN
pome scenarios gmail --copy
```

`POME_GMAIL_TOKEN` is the same Pome session JWT as `POME_AUTH_TOKEN`; it is not
a Google OAuth token. Hosted Gmail availability is gated separately from the
local/OSS package release.

## Quickstart

```bash
pome login                       # one-time; opens the dashboard to sign in
pome init                        # scaffolds scenarios/, examples/agents/, runs/, pome.config.json
pome register agent my-agent     # scopes runs to this project
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome inspect latest              # trace/audit view of the last run
```

To capture a trace without the cloud (self-host), then get a verdict later:

```bash
pome run --local scenarios/01-bug-happy-path.md   # captures a raw trace only — no verdict
pome eval runs/01-bug-happy-path/<run-id>         # uploads it for a cloud verdict
```

See [docs.pome.sh](https://docs.pome.sh) for the task library, exit-code
contract, authentication, the Stripe/Slack twins, and everything else.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The package publishes the `pome` binary from `dist/src/cli/main.js`.

### Versioning — every behavior change ships with a bump

Any PR that touches `cli/src/**` must either add a changeset under
`cli/.changeset/` or bump `cli/package.json` directly; CI enforces this
via [`scripts/check-cli-version-bump.sh`](../scripts/check-cli-version-bump.sh).
Preferred path: `cd cli && npm run changeset`.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
