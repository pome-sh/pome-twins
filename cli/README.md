# Pome CLI

The `pome` command runs AI-agent scenarios against resettable digital twins of
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

Until the first npm release ships, install from the GitHub source checkout:

```bash
git clone --depth 1 https://github.com/pome-sh/pome-twins.git
cd pome-twins/cli
npm install        # installs deps + runs the `prepare` build
npm install -g .
pome --help
```

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

See [docs.pome.sh](https://docs.pome.sh) for the scenario library, exit-code
contract, authentication, the Stripe/Slack twins, and everything else.

## Development

```bash
bun install
bun run typecheck
bun run build
bun run test
```

The package publishes the `pome` binary from `dist/src/cli/main.js`.

### Versioning — every behavior change ships with a bump

Any PR that touches `cli/src/**` must either add a changeset under
`cli/.changeset/` or bump `cli/package.json` directly; CI enforces this
via [`scripts/check-cli-version-bump.sh`](../scripts/check-cli-version-bump.sh).
Preferred path: `cd cli && bun changeset`.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
