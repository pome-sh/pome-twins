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

## Quickstart

Prerequisites: [Node.js ≥ 24](https://nodejs.org/). Nothing else — no
installs, no git clone.

Start a twin (GitHub, Stripe, or Slack):

```bash
npx @pome-sh/cli twin start github         # GitHub twin on http://127.0.0.1:3333
curl http://127.0.0.1:3333/healthz
```

It runs in the foreground (Ctrl-C to stop) and prints the twin's MCP URL plus
a ready-minted `POME_AUTH_TOKEN` for the session it serves — everything an
agent needs to connect.

Then run your first agent scenario. `pome init` scaffolds the scenario
library and a scripted example agent; `pome run --local` boots its own twin
in-process, seeds the scenario, runs the agent, and records the trace:

```bash
npx @pome-sh/cli init
npx @pome-sh/cli run --local scenarios/01-bug-happy-path.md   # captures a trace
npx @pome-sh/cli inspect latest                               # read it back
```

Run each twin on its own port with `--port` (e.g.
`npx @pome-sh/cli twin start stripe --port 3334`). To develop a twin from
source: `npm run dev -w @pome-sh/twin-github`. Each twin has its own README
under [`packages/`](./packages/).

**State, persistence, auth.** Each `pome twin start` boot serves a fresh copy
of the twin's seeded demo world; `POST /admin/reset` returns to it in place.
The GitHub twin's SQLite can live on disk via `GITHUB_CLONE_DB=<path>`. Auth
is env-first: an exported `TWIN_AUTH_SECRET` (≥ 32 chars) always wins;
otherwise the CLI reuses a secret a previous twin boot persisted under
`.pome-data/<twin>/secret` (`POME_TWIN_DATA_DIR` overrides the directory),
else it generates a per-boot secret — either way it prints a ready-to-use
`POME_AUTH_TOKEN`.

## CLI Installation

The quickstart's `npx @pome-sh/cli` needs no install. For a persistent `pome`
command:

```bash
npm install -g @pome-sh/cli
pome --help
```

Run `pome login` once to connect the CLI to your Pome account, then `pome init`
in any project where you want scenarios and run artifacts.

## The example agents

[`examples/triage-agent`](./examples/triage-agent/) is the worked
Claude Agent SDK example: with a twin running (see quickstart) and an
[Anthropic API key](https://console.anthropic.com/), it triages the seeded
issues on `acme/api` end-to-end:

```bash
git clone https://github.com/pome-sh/pome-twins.git && cd pome-twins/examples/triage-agent
npm install
export POME_AUTH_TOKEN=…                   # printed by `npx @pome-sh/cli twin start github`
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

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

