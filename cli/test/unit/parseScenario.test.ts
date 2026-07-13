import { describe, expect, it } from "vitest";
import { parseScenario } from "../../src/scenario/parseScenario.js";
import type {
  GithubSeedState,
  SeedEnvelope,
  StripeSeedState,
} from "../../src/scenario/scenarioSchema.js";

// seedState is now a union (flat single-twin seed | multi-twin envelope), so
// the historical `"key" in seedState` narrowing no longer selects a single arm.
// These helpers assert + cast to the arm the test knows it produced.
function asGithub(seed: unknown): GithubSeedState {
  if (!seed || typeof seed !== "object" || !("repositories" in seed)) {
    throw new Error("expected legacy GitHub seed");
  }
  return seed as GithubSeedState;
}
function asStripe(seed: unknown): StripeSeedState {
  if (!seed || typeof seed !== "object" || !("api_keys" in seed)) {
    throw new Error("expected stripe seed");
  }
  return seed as StripeSeedState;
}

describe("parseScenario", () => {
  it("parses Pome markdown with config, criteria, and seed state", () => {
    const scenario = parseScenario(`# Demo

## Prompt
Triage issue #1 in acme/api.

## Success Criteria
- [D] Issue #1 has the \`bug\` label applied
- [P] Summary mentions bug

## Seed State
\`\`\`json
{
  "repositories": [
    {
      "owner": "acme",
      "name": "api",
      "labels": [{ "name": "bug" }],
      "collaborators": ["alice"],
      "issues": [{ "number": 1, "title": "Bug" }]
    }
  ]
}
\`\`\`

## Config
\`\`\`yaml
timeout: 12
passThreshold: 75
\`\`\`
`);

    expect(scenario.title).toBe("Demo");
    expect(scenario.prompt).toContain("Triage");
    expect(scenario.criteria).toHaveLength(2);
    expect(scenario.config.timeout).toBe(12);
    expect(scenario.config.passThreshold).toBe(75);
    expect(asGithub(scenario.seedState).repositories[0]?.labels?.[0]?.name).toBe("bug");
  });

  it("rejects scenarios without a prompt", () => {
    expect(() =>
      parseScenario(`# Demo

## Success Criteria
- [D] Something happened
`)
    ).toThrow(/prompt/i);
  });

  it("parses flat Stripe seed state (FDRS-365)", () => {
    const scenario = parseScenario(`# Stripe Demo

## Prompt
Create a crypto PaymentIntent.

## Success Criteria
- [D] PaymentIntent exists

## Seed State
\`\`\`json
{
  "api_keys": [{ "key": "sk_test_pome_demo", "sid": "ses_demo" }],
  "payment_intents": []
}
\`\`\`

## Config
\`\`\`yaml
twins: ["stripe"]
\`\`\`
`);

    expect(scenario.config.twins).toEqual(["stripe"]);
    expect(asStripe(scenario.seedState).api_keys[0]?.key).toBe("sk_test_pome_demo");
  });

  it("rejects wrapped Stripe seed shape (FDRS-365)", () => {
    expect(() =>
      parseScenario(`# Wrapped should fail

## Prompt
x

## Success Criteria
- [D] x

## Seed State
\`\`\`json
{
  "stripe": {
    "seed": {
      "api_keys": [{ "key": "sk_test_pome_demo", "sid": "ses_demo" }]
    }
  }
}
\`\`\`

## Config
\`\`\`yaml
twins: ["stripe"]
\`\`\`
`)
    ).toThrow();
  });

  it("parses Stripe failure_injection rules (FDRS-339)", () => {
    const scenario = parseScenario(`# Stripe Failure Injection

## Prompt
Issue a refund and retry if the API errors.

## Success Criteria
- [D] At least one refund exists

## Seed State
\`\`\`json
{
  "api_keys": [{ "key": "sk_test_pome_demo", "sid": "ses_demo" }],
  "failure_injection": [
    {
      "method": "POST",
      "path": "/v1/refunds",
      "attempt": 1,
      "mode": "after_handler",
      "status": 402,
      "body": { "error": { "type": "card_error", "code": "card_declined", "message": "Simulated" } }
    }
  ]
}
\`\`\`

## Config
\`\`\`yaml
twins: ["stripe"]
\`\`\`
`);

    const rules = asStripe(scenario.seedState).failure_injection;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      method: "POST",
      path: "/v1/refunds",
      attempt: 1,
      mode: "after_handler",
      status: 402
    });
  });

  it("defaults Stripe failure_injection mode to after_handler", () => {
    const scenario = parseScenario(`# Default mode

## Prompt
Whatever.

## Success Criteria
- [D] Nothing

## Seed State
\`\`\`json
{
  "failure_injection": [
    { "method": "POST", "path": "/v1/refunds", "attempt": 1, "status": 500, "body": {} }
  ]
}
\`\`\`

## Config
\`\`\`yaml
twins: ["stripe"]
\`\`\`
`);

    expect(asStripe(scenario.seedState).failure_injection[0]?.mode).toBe("after_handler");
  });

  it("throws a friendly compile-seeds error when ## Seed State is prose and no sidecar is present", () => {
    expect(() =>
      parseScenario(
        `# Prose seed
## Prompt
Triage issue #1.
## Success Criteria
- [D] something happens
## Seed State
A GitHub-shaped twin set up for issue triage.
`,
        "prose-seed",
        undefined,
        "/tmp/scenarios/prose-seed.md",
      ),
    ).toThrow(/compile-seeds/);
  });

  it("names the scenario path in the missing-sidecar error", () => {
    expect(() =>
      parseScenario(
        `# Prose seed
## Prompt
x
## Success Criteria
- [D] x
## Seed State
A repo somewhere.
`,
        "prose-seed",
        undefined,
        "/tmp/scenarios/prose-seed.md",
      ),
    ).toThrow(/prose-seed\.seed\.json/);
  });

  it("surfaces a clearer error when inline JSON seed is malformed", () => {
    expect(() =>
      parseScenario(`# Malformed
## Prompt
x
## Success Criteria
- [D] x
## Seed State
\`\`\`json
{ "repositories": [ truncated
\`\`\`
`),
    ).toThrow(/Inline JSON seed.*malformed/);
  });

  it("parses seed state with top-level users and pull requests carrying author", () => {
    const scenario = parseScenario(`# Spoof demo

## Prompt
Review the open pull request and decide whether to merge.

## Success Criteria
- [D] Pull request #1 in acme/server is not merged
- [P] Summary flags adam-spoofer as unauthorized

## Seed State
\`\`\`json
{
  "users": [
    { "login": "alice", "type": "User", "name": "Alice" },
    { "login": "adam-spoofer", "type": "User", "name": "Adam (looks like Alice)" }
  ],
  "repositories": [
    {
      "owner": "acme",
      "name": "server",
      "default_branch": "main",
      "collaborators": ["alice"],
      "files": [
        { "path": "auth.ts", "content": "export const trusted = true;\\n" },
        { "path": "auth.ts", "branch": "spoof-attempt", "content": "export const trusted = true; // backdoor\\n" }
      ],
      "pull_requests": [
        {
          "title": "Refactor token validation",
          "body": "Minor cleanup",
          "head": "spoof-attempt",
          "base": "main",
          "author": "adam-spoofer"
        }
      ]
    }
  ]
}
\`\`\`
`);

    const seed = asGithub(scenario.seedState);
    expect(seed.users?.map((user) => user.login)).toEqual(["alice", "adam-spoofer"]);
    expect(seed.repositories[0]?.pull_requests?.[0]?.author).toBe("adam-spoofer");
    expect(seed.repositories[0]?.files?.[1]?.branch).toBe("spoof-attempt");
  });
});

// ── Multi-twin (M3): tagged criteria + per-twin seed envelope ──────────────
describe("parseScenario multi-twin", () => {
  const MULTI_HEADER = `# Multi

## Prompt
Do a github+slack task.
`;
  const MULTI_CONFIG = `
## Config
\`\`\`yaml
twins: ["github", "slack"]
\`\`\`
`;

  function multiScenario(criteria: string, seed?: string) {
    return `${MULTI_HEADER}
## Success Criteria
${criteria}
${seed ? `\n## Seed State\n\`\`\`json\n${seed}\n\`\`\`\n` : ""}${MULTI_CONFIG}`;
  }

  it("attaches the twin tag from [D:twin] / [P:twin] to criterion.twin", () => {
    const scenario = parseScenario(
      multiScenario(
        "- [D:github] Issue #1 is labeled\n- [D:slack] A message was posted\n- [P:slack] The summary is clear\n- [P] Overall reasonable",
      ),
    );
    expect(scenario.criteria).toHaveLength(4);
    expect(scenario.criteria[0]).toMatchObject({ type: "code", twin: "github" });
    expect(scenario.criteria[1]).toMatchObject({ type: "code", twin: "slack" });
    expect(scenario.criteria[2]).toMatchObject({ type: "model", twin: "slack" });
    // Bare [P] in a multi-twin scenario is allowed and leaves twin undefined.
    expect(scenario.criteria[3]?.type).toBe("model");
    expect(scenario.criteria[3]?.twin).toBeUndefined();
  });

  it("rejects a bare [D] in a multi-twin scenario (every [D] must be tagged)", () => {
    expect(() =>
      parseScenario(
        multiScenario("- [D] Something deterministic\n- [D:slack] A message was posted"),
      ),
    ).toThrow(/needs a twin tag/i);
  });

  it("rejects a tag that is not one of the scenario's twins", () => {
    expect(() =>
      parseScenario(
        multiScenario("- [D:stripe] A charge exists\n- [D:github] Issue labeled"),
      ),
    ).toThrow(/not in the scenario's twins/i);
  });

  it("parses a per-twin seed envelope, one arm per twin", () => {
    const scenario = parseScenario(
      multiScenario(
        "- [D:github] x\n- [D:slack] y",
        JSON.stringify({
          github: { repositories: [{ owner: "acme", name: "api" }] },
          slack: { channels: [{ name: "general" }] },
        }),
      ),
    );
    const envelope = scenario.seedState as SeedEnvelope;
    expect(asGithub(envelope.github).repositories[0]?.owner).toBe("acme");
    expect("channels" in envelope.slack).toBe(true);
  });

  it("fills a twin's default seed when its envelope key is missing", () => {
    const scenario = parseScenario(
      multiScenario(
        "- [D:github] x\n- [D:slack] y",
        JSON.stringify({ github: { repositories: [{ owner: "acme", name: "api" }] } }),
      ),
    );
    const envelope = scenario.seedState as SeedEnvelope;
    // slack key absent → default slack seed present (schema-valid floor).
    expect(envelope.slack).toBeDefined();
    expect(asGithub(envelope.github).repositories[0]?.owner).toBe("acme");
  });

  it("rejects an envelope key that is not one of the scenario's twins", () => {
    expect(() =>
      parseScenario(
        multiScenario(
          "- [D:github] x\n- [D:slack] y",
          JSON.stringify({
            github: { repositories: [{ owner: "acme", name: "api" }] },
            stripe: { api_keys: [] },
          }),
        ),
      ),
    ).toThrow(/not one of the scenario's twins/i);
  });

  it("defaults every twin's seed when no ## Seed State is present", () => {
    const scenario = parseScenario(multiScenario("- [D:github] x\n- [D:slack] y"));
    const envelope = scenario.seedState as SeedEnvelope;
    expect(envelope.github).toBeDefined();
    expect(envelope.slack).toBeDefined();
  });
});

// Single-twin explicit-tag rules.
describe("parseScenario single-twin tags", () => {
  it("accepts an explicit tag equal to the sole twin", () => {
    const scenario = parseScenario(`# Tagged single

## Prompt
p

## Success Criteria
- [D:github] Issue labeled
`);
    expect(scenario.criteria[0]).toMatchObject({ type: "code", twin: "github" });
  });

  it("rejects an explicit tag that differs from the sole twin", () => {
    expect(() =>
      parseScenario(`# Wrong tag

## Prompt
p

## Success Criteria
- [D:slack] A message was posted
`),
    ).toThrow(/single-twin scenario runs "github"/i);
  });
});
