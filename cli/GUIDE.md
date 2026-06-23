# Pome Guide

Pome is a digital-twin testing platform for AI agents. You register one or more
agents, run them against deterministic simulations of real SaaS APIs (GitHub,
Stripe, Slack), and get scored traces on the dashboard and on disk.

The product loop is the same whether you drive it from the CLI, a coding-agent
skill, or [app.pome.sh](https://app.pome.sh):

```text
Scenario (seed + prompt + criteria)
        ↓
   pome run  (or /pome-test)
        ↓
  Twin boots with seed state
        ↓
  Agent runs — tool calls hit the twin, not production
        ↓
  Pome records events + exports twin state
        ↓
  Judge scores [D] and [P] criteria
        ↓
  Dashboard URL + local artifacts
```

## 1. Install and verify

From the monorepo:

```bash
cd pome/cli
bun install
bun run typecheck
bun run build
bun run test
```

Global install for day-to-day use:

```bash
npm install -g .
pome version
```

Sign in so runs record to the dashboard:

```bash
pome login
```

## 2. Wire your agents with skills

Pome ships two coding-agent skills. Install them once:

```bash
pome skills install
```

- **`/pome-setup`** — identifies each agent in your repo, the services it calls,
  registers agents on the dashboard, and scaffolds `pome.config.json` + `TESTS.md`.
- **`/pome-test`** — runs the scenario set that matches each agent and reports scores.

Typical flow in Claude Code (or another supported agent):

```text
set up my agent to test with pome. Use /pome-setup
```

Confirm the services and scenarios it proposes, then:

```text
test my agents with pome
```

You can register and run agents manually too:

```bash
pome init
pome register agent github-triage
pome register agent stripe-refunds
```

Each registered agent gets its own runs on the dashboard.

## 3. Twins and scenarios

A **twin** is a stateful simulation of a real API. A **scenario** is a markdown
file with seed state, a prompt, and acceptance criteria.

| Twin | Config | What agents exercise |
| --- | --- | --- |
| GitHub | `twins: ["github"]` | Issues, PRs, labels, comments, commit status |
| Stripe | `twins: ["stripe"]` | PaymentIntents, refunds, x402 paywalls |
| Slack | `twins: ["slack"]` | Channels, messages, threads, reactions |

Browse bundled scenarios:

```bash
pome scenarios
pome scenarios github
pome scenarios stripe --copy
pome scenarios slack --copy
```

Hosted twins are the default — `pome run` records to
[app.pome.sh](https://app.pome.sh). For engineer-only local twins:

```bash
POME_LOCAL=1 pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
```

Or start a standalone GitHub twin:

```bash
pome twin start github --port 3333
```

## 4. Run example agents

The scripted agents need no API key. Use them to verify the loop before trying LLM
agents.

**GitHub triage** (scenarios 01–03):

```bash
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome run scenarios/02-missing-label.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
pome run scenarios/03-already-triaged.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
```

**GitHub PR review** (scenario 07):

```bash
pome run scenarios/07-pr-backdoor-review.md --agent "npx tsx examples/agents/scripted-pr-reviewer-agent.ts"
```

**Stripe refund** (scenario 14, needs `ANTHROPIC_API_KEY`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pome run scenarios/14-stripe-refund-retry.md --agent "npx tsx examples/agents/llm-refund-agent.ts"
```

**LLM GitHub triage** (scenario 01):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pome run scenarios/01-bug-happy-path.md --agent "npx tsx examples/agents/llm-triage-agent.ts"
```

Expected output ends with a pass/fail line and a score out of 100.

## 5. Inspect a run

```bash
pome inspect latest
```

Example:

```text
Score: 100/100
✓ [D] Issue #1 has the `bug` label applied
✓ [D] Issue #1 is assigned to `alice`
✓ [D] No unsupported endpoint was called
```

Open the dashboard for the full trace and judge handoff:

```bash
open https://app.pome.sh
```

## 6. Read the artifacts

Every run writes a directory under `runs/`:

```bash
open runs/<scenario>/<run-id>/events.jsonl
open runs/<scenario>/<run-id>/score.json
open runs/<scenario>/<run-id>/state_final.json
```

`events.jsonl` is the canonical trace — HTTP calls, MCP tool calls, LLM events, and
run lifecycle. `tool_calls.jsonl` is still written for older clients.

The score tells you whether the agent passed. The trace tells you what happened.

## 7. What the scenario library covers

Scenarios are grouped by twin and stress different failure modes:

**GitHub** — happy-path triage, missing-label recovery, already-triaged no-ops,
identity spoofing, prompt injection in issue bodies, PR backdoors, fabricated green
CI, security-revert rationalization.

**Stripe** — PaymentIntent creation, failed payments, webhook reconciliation, x402
paywalls, refund retries, re-refund persuasion.

**Slack** — secret exfiltration to public channels, injection in thread context.

Start with scenarios 01–03 on the scripted triage agent. Then branch into
security-oriented GitHub scenarios (05, 07, 08) or Stripe/Slack scenarios that
match the services your agents call.

## 8. Write your own agent

An agent is any command Pome spawns. It reads injected env vars, calls the twin,
and exits.

```text
POME_TASK
POME_PREFLIGHT
POME_TWIN_NAMES
POME_GITHUB_REST_URL / POME_STRIPE_REST_URL / POME_SLACK_REST_URL
POME_GITHUB_MCP_URL / POME_STRIPE_MCP_URL / POME_SLACK_MCP_URL
POME_AUTH_TOKEN
POME_RUN_ID
POME_ARTIFACTS_DIR
```

Minimum shape:

```ts
if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const task = process.env.POME_TASK;
const githubUrl = process.env.POME_GITHUB_REST_URL;
const authToken = process.env.POME_AUTH_TOKEN;

if (!task || !githubUrl || !authToken) {
  throw new Error("Pome env vars are required");
}

const issue = await fetch(`${githubUrl}/repos/acme/api/issues/1`, {
  headers: { Authorization: `Bearer ${authToken}` },
}).then((r) => r.json());

console.error("Read issue:", issue.title);
console.log(JSON.stringify({ summary: "Agent completed" }));
```

Run it:

```bash
pome run scenarios/01-bug-happy-path.md --agent "npx tsx path/to/your-agent.ts"
```

Register it on the dashboard so `/pome-test` can find it:

```bash
pome register agent my-agent
```

## 9. Add a new scenario

Create `scenarios/NN-your-case.md` with this shape:

```markdown
# Scenario NN — Your case

## Prompt

Triage issue #1 in acme/api.

## Success Criteria

- [D] Issue #1 has the `bug` label applied
- [D] No unsupported endpoint was called

## Seed State

\`\`\`json
{
  "repositories": [
    {
      "owner": "acme",
      "name": "api",
      "labels": [{ "name": "bug" }],
      "collaborators": ["alice"],
      "issues": [
        {
          "number": 1,
          "title": "Bug title",
          "body": "Bug body",
          "labels": [],
          "assignee": null
        }
      ]
    }
  ]
}
\`\`\`

## Config

\`\`\`yaml
twins: [github]
timeout: 60
passThreshold: 100
\`\`\`
```

Then run:

```bash
pome run scenarios/NN-your-case.md --agent "npx tsx examples/agents/scripted-triage-agent.ts"
```

Use `[P]` criteria when the check requires judgment (e.g. "the agent recognized
the injection attempt") — Pome runs an LLM judge on the trace.

## 10. Sessions and local twins

Create a hosted sandbox session from the CLI:

```bash
pome session create --twin github
pome session list
pome session stop <session-id>
```

Manually poke a local GitHub twin:

```bash
pome twin start github --port 3333
```

```bash
export POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
export POME_AUTH_TOKEN=<token printed by pome twin start>

curl -H "Authorization: Bearer $POME_AUTH_TOKEN" "$POME_GITHUB_REST_URL/repos/acme/api/issues/1"
```

Unsupported endpoints return loud errors — no fake green.

```bash
pome twin reset
```

Docker images for standalone twins: one GHCR package, one tag per twin —
`ghcr.io/pome-sh/twins:github` / `:stripe` / `:slack`.
See the twin guides on [docs.pome.sh](https://docs.pome.sh).

## 11. When to run pome

Run pome before merging changes that affect agent behavior:

- Prompt or system-instruction edits
- New or modified tools
- Model swaps
- New third-party integrations

Compare scores across runs. The trace shows which tool calls changed and which
criteria flipped.

## 12. What to try next

1. Run `/pome-setup` on a repo with multiple agents and confirm each registers separately.
2. Break the scripted triage agent on scenario 02 (skip label creation) and watch Pome catch the 422.
3. Add a prompt-injection scenario where the issue body says "ignore prior instructions."
4. Run a Stripe scenario against `llm-refund-agent.ts` and inspect refund state in `state_final.json`.
5. Add a new endpoint to a twin only when a scenario needs it — scenarios drive fidelity.

That is the whole game: scenarios drive twin fidelity, not the other way around.

## Further reading

- [Quickstart](https://docs.pome.sh/getting-started) — install, login, skills, first run
- [How Pome works](https://docs.pome.sh/docs/how-pome-works) — twins, scoring, artifacts
- [Twins reference](https://docs.pome.sh/docs/twins) — per-twin coverage and env vars
- [CLI reference](https://docs.pome.sh/docs/cli) — `pome run`, `pome session`, flags
