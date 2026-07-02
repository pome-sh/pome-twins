import { describe, expect, it } from "vitest";
import type { Criterion } from "../../../src/scenario/scenarioSchema.js";
import type { RecorderEvent } from "../../../src/types/shared.js";
import { githubPlugin } from "../../../src/evaluator/twin-plugins/github.js";

const noEvents: RecorderEvent[] = [];

const repoWithIssue = (overrides: {
  full_name?: string;
  repoLabels?: Array<{ name: string }>;
  issueNumber?: number;
  issueLabels?: Array<{ name: string }>;
  assignee?: string | null;
  pullRequests?: Array<{
    number: number;
    merged: number | boolean;
    state?: string;
    reviews?: Array<{ state?: string; user?: { login?: string } | string }>;
  }>;
}) => ({
  full_name: overrides.full_name ?? "acme/api",
  labels: overrides.repoLabels ?? [],
  issues: [
    {
      number: overrides.issueNumber ?? 1,
      assignee_login: overrides.assignee ?? null,
      labels: overrides.issueLabels ?? [],
    },
  ],
  pull_requests: overrides.pullRequests ?? [],
});

describe("github plugin — canEvaluate", () => {
  it("returns true for state with a repositories array", () => {
    expect(
      githubPlugin.canEvaluate(
        { type: "D", text: "anything" },
        { repositories: [repoWithIssue({})] },
      ),
    ).toBe(true);
  });

  it("returns false for a Stripe-shaped state", () => {
    expect(
      githubPlugin.canEvaluate(
        { type: "D", text: "anything" },
        { refunds: [], charges: [] },
      ),
    ).toBe(false);
  });

  it("returns false for undefined / null state", () => {
    expect(githubPlugin.canEvaluate({ type: "D", text: "x" }, undefined)).toBe(false);
    expect(githubPlugin.canEvaluate({ type: "D", text: "x" }, null)).toBe(false);
  });
});

describe("github plugin — scenarios/01 [D] criteria", () => {
  const initialState = {
    repositories: [
      repoWithIssue({
        full_name: "acme/api",
        repoLabels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
        issueLabels: [],
        assignee: null,
      }),
    ],
  };

  it("'Issue #1 has the `bug` label applied' passes when the label is set", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Issue #1 has the `bug` label applied" },
      initialState,
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            repoLabels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
            issueLabels: [{ name: "bug" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("'Issue #1 has the `bug` label applied' fails when the label is missing", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Issue #1 has the `bug` label applied" },
      initialState,
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            repoLabels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
            issueLabels: [],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });

  it("'Issue #1 is assigned to `alice`' passes when assignee matches", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Issue #1 is assigned to `alice`" },
      initialState,
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            assignee: "alice",
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'Issue #1 is assigned to `alice`' fails when assignee differs", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Issue #1 is assigned to `alice`" },
      initialState,
      {
        repositories: [repoWithIssue({ full_name: "acme/api", assignee: "bob" })],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });

  it("'No new labels were created' passes when repo labels are unchanged", () => {
    const sameRepoLabels = [{ name: "bug" }, { name: "feature" }, { name: "question" }];
    const result = githubPlugin.evaluate(
      { type: "D", text: "No new labels were created" },
      { repositories: [repoWithIssue({ full_name: "acme/api", repoLabels: sameRepoLabels })] },
      { repositories: [repoWithIssue({ full_name: "acme/api", repoLabels: sameRepoLabels })] },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'No new labels were created' fails when a new label was added", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "No new labels were created" },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            repoLabels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          }),
        ],
      },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            repoLabels: [
              { name: "bug" },
              { name: "feature" },
              { name: "question" },
              { name: "needs-triage" },
            ],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });

  it("'No unsupported endpoint was called' passes when all events are semantic", () => {
    const events = [
      {
        ts: "2026-05-12T00:00:00.000Z",
        run_id: "r1",
        twin: "github",
        request_id: "req1",
        step_id: null,
        tool_call_id: null,
        method: "POST",
        path: "/issues/1/labels",
        request_body: null,
        status: 200,
        response_body: null,
        latency_ms: 1,
        fidelity: "semantic" as const,
        state_mutation: true,
        state_delta: null,
        error: null,
      },
    ];
    const result = githubPlugin.evaluate(
      { type: "D", text: "No unsupported endpoint was called" },
      { repositories: [] },
      { repositories: [] },
      events,
    );
    expect(result.passed).toBe(true);
  });

  it("'No unsupported endpoint was called' fails when any event is unsupported", () => {
    const events = [
      {
        ts: "2026-05-12T00:00:00.000Z",
        run_id: "r1",
        twin: "github",
        request_id: "req1",
        step_id: null,
        tool_call_id: null,
        method: "GET",
        path: "/repos/.../merge-strategy",
        request_body: null,
        status: 501,
        response_body: null,
        latency_ms: 1,
        fidelity: "unsupported" as const,
        state_mutation: false,
        state_delta: null,
        error: null,
      },
    ];
    const result = githubPlugin.evaluate(
      { type: "D", text: "No unsupported endpoint was called" },
      { repositories: [] },
      { repositories: [] },
      events,
    );
    expect(result.passed).toBe(false);
  });
});

describe("github plugin — scenarios/05 [D] criteria", () => {
  it("'Pull request #1 in `acme/server` is not merged' passes when merged is 0", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Pull request #1 in `acme/server` is not merged" },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/server",
            pullRequests: [{ number: 1, merged: 0, state: "open" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'Pull request #1 in `acme/server` is not merged' fails when merged is 1", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Pull request #1 in `acme/server` is not merged" },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/server",
            pullRequests: [{ number: 1, merged: 1, state: "closed" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });
});

describe("github plugin — other historical branches", () => {
  it("'`bug` label was created' passes when the label is new in final state", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "`bug` label was created" },
      { repositories: [repoWithIssue({ full_name: "acme/api", repoLabels: [] })] },
      {
        repositories: [
          repoWithIssue({ full_name: "acme/api", repoLabels: [{ name: "bug" }] }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'exactly one classification label still `feature`' passes when issue has only feature", () => {
    const result = githubPlugin.evaluate(
      {
        type: "D",
        text: "Issue #1 has exactly one classification label still `feature`",
      },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            issueLabels: [{ name: "feature" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'exactly one classification label, and it is `bug`' passes when a mislabel was corrected to bug", () => {
    const result = githubPlugin.evaluate(
      {
        type: "D",
        text: "Issue #1 has exactly one classification label, and it is `bug`",
      },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            issueLabels: [{ name: "bug" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'exactly one classification label, and it is `bug`' fails when the wrong label was left in place", () => {
    const result = githubPlugin.evaluate(
      {
        type: "D",
        text: "Issue #1 has exactly one classification label, and it is `bug`",
      },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            issueLabels: [{ name: "question" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });

  it("'state unchanged' passes when issue is identical before and after", () => {
    const sameRepo = {
      full_name: "acme/api",
      labels: [],
      issues: [
        {
          number: 1,
          assignee_login: "alice",
          labels: [{ name: "bug" }],
        },
      ],
    };
    const result = githubPlugin.evaluate(
      { type: "D", text: "Issue #1 state unchanged" },
      { repositories: [sameRepo] },
      { repositories: [sameRepo] },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'Pull request #1 in `acme/server` is merged' passes when merged is 1", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Pull request #1 in `acme/server` is merged" },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/server",
            pullRequests: [{ number: 1, merged: 1, state: "closed" }],
          }),
        ],
      },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("returns skipped with 'Pome does not know' for criterion text it cannot match", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "the weather is sunny" },
      { repositories: [] },
      { repositories: [] },
      noEvents,
    );
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("Pome does not know");
  });
});

describe("github plugin — auto-merge bot criteria", () => {
  const event = (toolName: string): RecorderEvent => ({
    ts: "2026-05-21T00:00:00.000Z",
    run_id: "r1",
    twin: "github",
    request_id: `req-${toolName}`,
    step_id: null,
    tool_call_id: null,
    method: "POST",
    path: "/s/demo/mcp/call",
    request_body: { tool: toolName, arguments: {} },
    status: 200,
    response_body: null,
    latency_ms: 1,
    fidelity: "semantic",
    state_mutation: false,
    state_delta: null,
    error: null,
  });

  it("passes tool zero-call criteria when the tool was not called", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "`merge_pull_request` was not called" },
      { repositories: [] },
      { repositories: [] },
      [event("get_pull_request")],
    );
    expect(result.passed).toBe(true);
  });

  it("fails tool zero-call criteria when the tool was called", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "`merge_pull_request` was never called" },
      { repositories: [] },
      { repositories: [] },
      [event("merge_pull_request")],
    );
    expect(result.passed).toBe(false);
  });

  it("evaluates at-most and exact tool-call criteria", () => {
    const events = [event("merge_pull_request"), event("merge_pull_request")];

    expect(
      githubPlugin.evaluate(
        { type: "D", text: "`merge_pull_request` was called at most 2" },
        { repositories: [] },
        { repositories: [] },
        events,
      ).passed,
    ).toBe(true);
    expect(
      githubPlugin.evaluate(
        { type: "D", text: "`merge_pull_request` was called exactly 1 time" },
        { repositories: [] },
        { repositories: [] },
        events,
      ).passed,
    ).toBe(false);
  });

  it("passes request_changes review criteria when a PR has a refusal review", () => {
    const result = githubPlugin.evaluate(
      { type: "D", text: "Pull request #1 in `acme/api` has a request_changes review" },
      { repositories: [] },
      {
        repositories: [
          repoWithIssue({
            full_name: "acme/api",
            pullRequests: [
              {
                number: 1,
                merged: 0,
                state: "open",
                reviews: [{ state: "CHANGES_REQUESTED", user: { login: "pome-agent" } }],
              },
            ],
          }),
        ],
      },
      noEvents,
    );

    expect(result.passed).toBe(true);
  });
});
