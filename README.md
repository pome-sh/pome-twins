# Pome Digital Twins

Open-source twins of the services your AI agent works with (GitHub, Stripe x402,
and Slack), plus the `pome` CLI to run agents against them.

A digital twin is an emulation of the real API hosted locally. A twin runs locally 
and answers the same REST and MCP calls your agent makes in production, backed
by a real SQLite state to ensure a stateful simulation for end-to-end testing.

You can use a digital twin to evaluate your AI Agents, train ML Models, or even write End-to-End tests
for agents that emulate production systems entirely. You can also use Pome Digital twins to evaluate AI
against 1000s of scenarios on Pome. 

You can open a pull request against the GitHub twin and it is there to list, review, and merge,
gated by the same push-access rules as the live API. Create a Stripe payment and the balance moves.
Post to a Slack channel and the next read returns the message. Reset the twin and you are
back to a known starting world, with no live rate limits and no shared sandbox
accounts.

This repository is the twins and the CLI. You can use Pome to assess your Agents evaluations, simulations,
and observabilitys, at <https://pome.sh>.

⚠️ Pome is in Beta. It's dependencies and CLI shape might change in the future. For questions or suggestions, email: `founders@pome.sh`

## CLI Installation

Install the `pome` command before running scenarios or hosted twins. Until the
first npm registry release ships, install from the GitHub source checkout.

```bash
git clone --depth 1 https://github.com/pome-sh/pome-twins.git
cd pome-twins/cli
npm install
npm install -g .
pome --help
```

If you prefer Bun:

```bash
bun install
bun run build
npm link
```

After installation, run `pome login` once to connect the CLI to your Pome
account, then run `pome init` in any project where you want scenarios and run
artifacts.

## Quickstart

Prerequisites: [Docker](https://docs.docker.com/get-docker/), [Bun ≥ 1.3](https://bun.sh),
and an [Anthropic API key](https://console.anthropic.com/) for the bundled example agent.

```bash
git clone https://github.com/pome-sh/pome-twins.git && cd pome-twins
docker compose up -d                       # GitHub twin on :3333
curl http://127.0.0.1:3333/healthz

cd examples/triage-agent
bun install
export ANTHROPIC_API_KEY=sk-ant-...
bun run start                              # triages a seeded issue on acme/api
```

Run all three twins with `docker compose --profile twins up -d` (ports 3333 /
3334 / 3335). All twins ship from one GHCR package, one tag per twin
(`ghcr.io/pome-sh/twins:github` / `:stripe` / `:slack`); it is private until
launch, so run `docker login ghcr.io` first. To develop a twin from
source: `bun run --filter @pome-sh/twin-github dev`. Each twin has its own README
under [`packages/`](./packages/).

## The twins

| Twin | Surface | State |
| --- | --- | --- |
| [`twin-github`](./packages/twin-github/) | GitHub REST + 35 MCP tools (repos, issues, PRs, reviews, collaborators, checks) | SQLite, push-access gated |
| [`twin-stripe`](./packages/twin-stripe/) | Stripe x402 REST + MCP (payment intents, refunds, balance) | SQLite, balance-consistent |
| [`twin-slack`](./packages/twin-slack/) | Slack Web API + MCP (channels, messages, reactions, files) | SQLite |

## Running an agent

`pome run --local` boots a twin in-process, runs your agent against it, and
records the run — the trace plus before/after state — for you to read back with
`pome inspect`. Self-hosted runs capture traces only. **Evaluation — scoring a
run against a scenario's pass/fail criteria — is a hosted feature** on the Pome
platform; there is no local scoring.

```bash
pome run --local scenarios/         # self-hosted: records a trace
pome login && pome run scenarios/   # hosted: records + evaluates
```

## Repo layout

| Path | Role |
| --- | --- |
| [`packages/twin-{github,stripe,slack}`](./packages/) | The three twins (REST + MCP, SQLite) |
| [`packages/shared-types`](./packages/shared-types/) | Zod schemas and trace contracts |
| [`packages/sdk`](./packages/sdk/) | Library for building your own twin |
| [`packages/adapter-claude-sdk`](./packages/adapter-claude-sdk/) | Wire a Claude Agent SDK agent to a Pome run |
| [`cli/`](./cli/) | The `pome` CLI (run scenarios, inspect traces, manage sessions) |
| [`cli/scenarios/`](./cli/scenarios/) | The bundled scenario library |
| [`examples/triage-agent`](./examples/triage-agent/) | Worked agent example (Claude Agent SDK + MCP) against the GitHub twin |
| [`examples/merge-agent`](./examples/merge-agent/) | Worked agent example (Vercel AI SDK + REST) — a PR merge agent vs. an identity-spoof scenario |

[Apache-2.0](./LICENSE)

