# Pome Digital Twins

Open-source API emulations for GitHub, Stripe, and Slack, powered by the `pome` CLI to run, test, and evaluate your AI agents locally.

A digital twin is a local emulation of a production API. It intercepts and answers the exact same **REST and MCP calls** your agent makes in production, backed by a real **SQLite database** to ensure high-fidelity, stateful simulations for end-to-end testing.

---

### Why use Pome Digital Twins?

* **Comprehensive Testing:** Build robust, end-to-end test suites that mimic production systems entirely without touching live infrastructure.
* **Agent Evaluation & ML Training:** Run your AI agents against thousands of complex scenarios locally or train machine learning models in a controlled environment.
* **Zero Friction:** Say goodbye to live rate limits, flaky networks, and messy, shared sandbox accounts. Need a fresh start? Just reset the twin to return to a known, clean state instantly.

### Real-World Emulation

* **GitHub:** Open, list, review, and merge pull requests—fully gated by the same push-access rules as the live API.
* **Stripe:** Create a payment and watch the account balance move dynamically.
* **Slack:** Post messages to channels and immediately verify them on the next read.

---

This repository contains the core digital twins and the CLI. To supercharge your agent evaluations, simulations, and observability, visit [pome.sh](https://pome.sh).

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

After installation, run `pome login` once to connect the CLI to your Pome
account, then run `pome init` in any project where you want scenarios and run
artifacts.

## Quickstart

Prerequisites: [Docker](https://docs.docker.com/get-docker/), [Node.js ≥ 24](https://nodejs.org/),
and an [Anthropic API key](https://console.anthropic.com/) for the bundled example agent.

```bash
git clone https://github.com/pome-sh/pome-twins.git && cd pome-twins
docker compose up -d                       # GitHub twin on :3333
curl http://127.0.0.1:3333/healthz

cd examples/triage-agent
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start                                  # triages a seeded issue on acme/api
```

Run all three twins with `docker compose --profile twins up -d` (ports 3333 /
3334 / 3335). All twins ship from one GHCR package, one tag per twin
(`ghcr.io/pome-sh/twins:github` / `:stripe` / `:slack`); it is private until
launch, so run `docker login ghcr.io` first. To develop a twin from
source: `npm run dev -w @pome-sh/twin-github`. Each twin has its own README
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

