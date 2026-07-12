# Pome Digital Twins

[![CI](https://github.com/pome-sh/pome-twins/actions/workflows/ci.yml/badge.svg)](https://github.com/pome-sh/pome-twins/actions/workflows/ci.yml)
[![Quickstart smoke](https://github.com/pome-sh/pome-twins/actions/workflows/quickstart-smoke.yml/badge.svg)](https://github.com/pome-sh/pome-twins/actions/workflows/quickstart-smoke.yml)
[![npm: @pome-sh/cli](https://img.shields.io/npm/v/%40pome-sh%2Fcli?label=%40pome-sh%2Fcli)](https://www.npmjs.com/package/@pome-sh/cli)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Open-source digital twins of GitHub, Stripe, and Slack: 102 MCP tools and 155
REST routes across the three, plus the `pome` CLI to run your AI agents
against them locally and capture every trace.

A digital twin is a local emulation of a production API. It intercepts and
answers the exact same **REST and MCP calls** your agent makes in production,
backed by a real **SQLite database** (Node's built-in `node:sqlite`, so
nothing native to compile). Every run is stateful, deterministic, and
resettable.

---

### Why use Pome Digital Twins?

* **Comprehensive Testing:** Build robust, end-to-end test suites that mimic
  production systems entirely without touching live infrastructure.
* **Agent Evaluation & ML Training:** Run your AI agents against the bundled
  scenario library, locally or in CI. Several scenarios are adversarial:
  identity spoofing, prompt injection, and friends.
* **Zero Friction:** Say goodbye to live rate limits, flaky networks, and
  messy shared sandbox accounts. Need a fresh start? Reset the twin and
  you're back to a known, clean state instantly.
* **Honest Fidelity:** Every route and tool is tiered: `semantic` (stateful
  behavior, tested), `shape` (faithful response shape), or a loud `501`. A
  twin never silently fakes success on a surface it doesn't implement.

### Real-World Emulation

* **GitHub:** Open, list, review, and merge pull requests — fully gated by the
  same push-access rules as the live API.
* **Stripe:** Confirm a card PaymentIntent (magic test cards decline exactly
  like real Stripe), settle an x402 crypto deposit, refund a charge, and watch
  the balance and event ledger move.
* **Slack:** Post messages, reply in threads, search, react — and verify all
  of it on the next read.

---

This repository contains the digital twins, the twin engine, and the CLI. To
supercharge your agent evaluations, simulations, and observability, visit
[pome.sh](https://pome.sh).

⚠️ Pome is in Beta. Its dependencies and CLI shape might change in the future.
For questions or suggestions, email: `founders@pome.sh`

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
in any project where you want scenarios and run artifacts. The full command
reference lives in the [CLI README](./cli/README.md) and at
[docs.pome.sh](https://docs.pome.sh).

## The twins

| Twin | MCP tools | REST routes | Highlights |
| --- | --- | --- | --- |
| [`twin-github`](./packages/twin-github/) | **65** (63 semantic) | 62 | Repos, issues, PRs, reviews, merges, collaborators, checks — push-access gated ([FIDELITY](./packages/twin-github/FIDELITY.md)) |
| [`twin-stripe`](./packages/twin-stripe/) | **26** (all semantic) | 43 | Card + x402 crypto PaymentIntents, customers, payment methods, refunds, charges, balance, events; billing surfaces at shape tier ([FIDELITY](./packages/twin-stripe/FIDELITY.md)) |
| [`twin-slack`](./packages/twin-slack/) | **11** (all semantic) | 50 | Channels, messages, threads, reactions, search, users, pins, scheduled messages ([FIDELITY](./packages/twin-slack/FIDELITY.md)) |

Each twin documents its surface, route by route, in its `FIDELITY.md`; the
tier definitions live in the engine-level
[endpoint-tier rubric](./packages/sdk/ENDPOINT-TIERS.md). All three honor the
frozen v1.1.0 runtime contract in [`CONTRACT.md`](./CONTRACT.md), verified by
a black-box suite (`npm run test:contract`) that both pome-cloud and the CLI
rely on. Published twin images are cosign-signed and ship SBOM attestations.

## Running an agent

`pome run --local` boots a twin in-process, runs your agent against it, and
records the run (the trace plus before/after state) for you to read back with
`pome inspect`. The CLI is **capture-only**: it never scores or judges
locally. Evaluation — scoring a run against a scenario's pass/fail criteria —
is a hosted feature on the Pome platform. `pome eval` bridges the two:
capture a trace anywhere, then upload it for a cloud verdict.

```bash
pome run --local scenarios/         # self-hosted: records a raw trace
pome eval runs/<scenario>/<run-id>  # uploads it for a cloud verdict
pome login && pome run scenarios/   # hosted: records + evaluates in one go
```

## The scenario library

`pome init` ships 19 ready-made scenarios: GitHub issue triage and PR flows,
Stripe x402 payment and refund flows, Slack messaging. Several are
adversarial — they probe whether your agent can be talked into spoofing an
identity, following an injected prompt, merging a backdoored PR, fabricating
green CI, or re-refunding a charge because someone asked nicely. Browse them
with `pome scenarios` or in [`cli/scenarios/`](./cli/scenarios/).

## The example agents

Four worked agents live under [`examples/`](./examples/):

| Example | Stack | What it does |
| --- | --- | --- |
| [`triage-agent`](./examples/triage-agent/) | Claude Agent SDK + MCP | Triages the seeded issues on `acme/api` end-to-end |
| [`merge-agent`](./examples/merge-agent/) | Vercel AI SDK + REST | A PR merge agent vs. an identity-spoof scenario |
| [`pr-summary-agent`](./examples/pr-summary-agent/) | Claude Agent SDK + MCP | Summarizes PRs: what/why/risk/checklist |
| [`pr-summary-review`](./examples/pr-summary-review/) | Claude Agent SDK + MCP | Summarizes **and** reviews PRs (approve / comment / request changes) |

To run the worked Claude Agent SDK example against a live twin (needs an
[Anthropic API key](https://console.anthropic.com/)):

```bash
git clone https://github.com/pome-sh/pome-twins.git && cd pome-twins/examples/triage-agent
npm install
export POME_AUTH_TOKEN=…                   # printed by `npx @pome-sh/cli twin start github`
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

## Build your own twin

The three twins are thin domain plugins on [`@pome-sh/sdk`](./packages/sdk/).
The engine supplies the mechanism — HTTP mounting, bearer auth, the trace
recorder with secret redaction, MCP dispatch, SQLite state, and the admin
reset/seed gate — so a twin is just its domain logic and tools:

```ts
import { defineTwin } from "@pome-sh/sdk";
import { serve } from "@pome-sh/sdk/server";

const twin = defineTwin({
  id: "my-service",
  version: "0.1.0",
  domain: ({ db, seed }) => createMyDomain(db, seed),
  tools: [/* ToolSpec[] — name, zod schema, handler */],
});

await serve(twin, { port: 3333 });
```

Every engine-booted twin gets `/healthz`, session mounts, and MCP surfaces
for free and automatically honors [`CONTRACT.md`](./CONTRACT.md). Start from
the [SDK README](./packages/sdk/README.md) and the
[endpoint-tier rubric](./packages/sdk/ENDPOINT-TIERS.md).

## Published packages

Everything ships to npm with provenance (Trusted Publishing):

| Package | Role |
| --- | --- |
| [`@pome-sh/cli`](https://www.npmjs.com/package/@pome-sh/cli) | The `pome` CLI |
| [`@pome-sh/twin-github`](https://www.npmjs.com/package/@pome-sh/twin-github) [`/twin-stripe`](https://www.npmjs.com/package/@pome-sh/twin-stripe) [`/twin-slack`](https://www.npmjs.com/package/@pome-sh/twin-slack) | The three twins |
| [`@pome-sh/sdk`](https://www.npmjs.com/package/@pome-sh/sdk) | The twin engine (`defineTwin()`) |
| [`@pome-sh/shared-types`](https://www.npmjs.com/package/@pome-sh/shared-types) | Zod schemas and the trace contract |
| [`@pome-sh/adapter-claude-sdk`](https://www.npmjs.com/package/@pome-sh/adapter-claude-sdk) | Wire a Claude Agent SDK agent to a Pome run |

## Repo layout

| Path | Role |
| --- | --- |
| [`packages/twin-{github,stripe,slack}`](./packages/) | The three twins (REST + MCP, SQLite) — each with `README` + `FIDELITY.md` |
| [`packages/sdk`](./packages/sdk/) | The twin engine — build your own twin with `defineTwin()` |
| [`packages/shared-types`](./packages/shared-types/) | Zod schemas and trace contracts |
| [`packages/adapter-claude-sdk`](./packages/adapter-claude-sdk/) | Wire a Claude Agent SDK agent to a Pome run |
| [`cli/`](./cli/) | The `pome` CLI (run scenarios, inspect traces, upload for evaluation) |
| [`cli/scenarios/`](./cli/scenarios/) | The bundled scenario library (19 scenarios) |
| [`examples/`](./examples/) | Four worked example agents |
| [`CONTRACT.md`](./CONTRACT.md) | The frozen twin runtime contract (v1.1.0) |
| [`AGENTS.md`](./AGENTS.md) | Contributor and agent conventions for this repo |

Full documentation lives at [docs.pome.sh](https://docs.pome.sh).

[Apache-2.0](./LICENSE)
