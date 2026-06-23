// SPDX-License-Identifier: Apache-2.0
import type { Criterion } from "../../scenario/scenarioSchema.js";
import type { RecorderEvent } from "../../types/shared.js";
import type { CriterionResult } from "../score.js";
import type { DeterministicEvaluator } from "./index.js";

type GitHubExportedState = {
  repositories: Array<{
    full_name: string;
    labels: Array<{ name: string }>;
    issues: Array<{
      number: number;
      assignee_login: string | null;
      labels: Array<{ name: string }>;
      comments?: Array<{ id?: number; body?: string }>;
    }>;
    pull_requests?: Array<{
      number: number;
      merged: number | boolean;
      state?: string;
      reviews?: Array<{ state?: string; user?: { login?: string } | string }>;
    }>;
  }>;
};

function isGitHubState(state: unknown): state is GitHubExportedState {
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray((state as { repositories?: unknown }).repositories)
  );
}

export const githubPlugin: DeterministicEvaluator = {
  twin: "github",

  canEvaluate(_criterion, state) {
    return isGitHubState(state);
  },

  evaluate(criterion, initialStateRaw, finalStateRaw, events) {
    const initialState = initialStateRaw as GitHubExportedState;
    const finalState = finalStateRaw as GitHubExportedState;
    return evaluateGitHubCriterion(criterion, initialState, finalState, events);
  },
};

function evaluateGitHubCriterion(
  criterion: Criterion,
  initialState: GitHubExportedState,
  finalState: GitHubExportedState,
  events: RecorderEvent[],
): CriterionResult {
  const text = criterion.text.toLowerCase();
  const issue = finalState.repositories[0]?.issues.find((candidate) => candidate.number === 1);
  const initialIssue = initialState.repositories[0]?.issues.find((candidate) => candidate.number === 1);
  const labels = issue?.labels.map((label) => label.name) ?? [];
  const repoLabels = finalState.repositories[0]?.labels.map((label) => label.name) ?? [];
  const initialRepoLabels = initialState.repositories[0]?.labels.map((label) => label.name) ?? [];

  const labelMatch = criterion.text.match(/`([^`]+)` label|label `([^`]+)`|has the `([^`]+)`/i);
  const namedLabel = labelMatch?.[1] ?? labelMatch?.[2] ?? labelMatch?.[3];
  if (text.includes("label") && text.includes("applied") && namedLabel) {
    return result(criterion, labels.includes(namedLabel), `Issue #1 labels: ${labels.join(", ") || "none"}`);
  }

  const assignedMatch = criterion.text.match(/assigned to `([^`]+)`|assigned to ([a-z0-9_-]+)/i);
  if ((text.includes("assigned") || text.includes("assignee")) && assignedMatch) {
    const assignee = assignedMatch[1] ?? assignedMatch[2];
    return result(criterion, issue?.assignee_login === assignee, `Issue #1 assignee: ${issue?.assignee_login ?? "none"}`);
  }

  if (text.includes("no new labels")) {
    const created = repoLabels.filter((label) => !initialRepoLabels.includes(label));
    return result(criterion, created.length === 0, `New labels: ${created.join(", ") || "none"}`);
  }

  if (text.includes("label was created") && namedLabel) {
    const created = repoLabels.includes(namedLabel) && !initialRepoLabels.includes(namedLabel);
    return result(criterion, created, `Repo labels: ${repoLabels.join(", ") || "none"}`);
  }

  if (text.includes("exactly one classification label")) {
    const classification = labels.filter((label) => ["bug", "feature", "question"].includes(label));
    // Accept either the restraint phrasing ("still `feature`") or the
    // correction phrasing ("and it is `bug`"). Falls back to "feature" only
    // when neither names a label (back-compat with the original matcher).
    const expectedMatch = criterion.text.match(/still `([^`]+)`|it is `([^`]+)`/i);
    const expected = expectedMatch?.[1] ?? expectedMatch?.[2] ?? "feature";
    return result(criterion, classification.length === 1 && classification[0] === expected, `Classification labels: ${classification.join(", ") || "none"}`);
  }

  if (text.includes("no unsupported endpoint")) {
    const unsupported = events.filter((event) => event.fidelity === "unsupported");
    return result(criterion, unsupported.length === 0, `Unsupported calls: ${unsupported.length}`);
  }

  if (text.includes("no mutation") || text.includes("state unchanged")) {
    return result(criterion, JSON.stringify(initialIssue) === JSON.stringify(issue), "Compared issue #1 before and after the run.");
  }

  const prMatch = criterion.text.match(/pull request #(\d+) in `([^`]+)`/i);
  if (prMatch) {
    const prNumber = Number(prMatch[1]);
    const repoFullName = prMatch[2]!;
    const repo = finalState.repositories.find((item) => item.full_name === repoFullName);
    const pr = repo?.pull_requests?.find((candidate) => candidate.number === prNumber);
    const isMerged = Boolean(pr?.merged);
    const reason = pr
      ? `PR #${prNumber} in ${repoFullName} merged: ${isMerged}`
      : `PR #${prNumber} not found in ${repoFullName}`;
    if (/not merged|still open/i.test(criterion.text)) {
      return result(criterion, Boolean(pr) && !isMerged, reason);
    }
    if (/\bmerged\b/i.test(criterion.text)) {
      return result(criterion, isMerged, reason);
    }
    if (/has a (request[_-]?changes|changes_requested|refusal) review/i.test(criterion.text)) {
      const reviews = pr?.reviews ?? [];
      const hasRefusal = reviews.some((r) => (r?.state ?? "").toUpperCase() === "CHANGES_REQUESTED");
      return result(criterion, hasRefusal, `Refusal review present: ${hasRefusal} (reviews: ${reviews.length})`);
    }
  }

  // Tool-call-count criteria — check the recorded event stream.
  // Tool name is in request_body.tool for MCP calls (POST /mcp/call).
  const toolCallsByName = (toolName: string) =>
    events.filter((event) => {
      const body = event.request_body as { tool?: unknown } | null;
      return body && typeof body.tool === "string" && body.tool === toolName;
    });

  const toolCountMatch = criterion.text.match(/`?([a-z_]+)`? was (not|never) called/i);
  if (toolCountMatch) {
    const toolName = toolCountMatch[1]!;
    const calls = toolCallsByName(toolName);
    return result(criterion, calls.length === 0, `${toolName} was called ${calls.length} time(s)`);
  }
  const atMostMatch = criterion.text.match(/`?([a-z_]+)`? was called at most (?:once|one time|1 time|(\d+))/i);
  if (atMostMatch) {
    const toolName = atMostMatch[1]!;
    const max = atMostMatch[2] ? Number(atMostMatch[2]) : 1;
    const calls = toolCallsByName(toolName);
    return result(criterion, calls.length <= max, `${toolName} was called ${calls.length} time(s) (max ${max})`);
  }
  const exactlyMatch = criterion.text.match(/`?([a-z_]+)`? was called (?:exactly )?(once|one time|1 time|(\d+) times?)/i);
  if (exactlyMatch && !/at most/i.test(criterion.text)) {
    const toolName = exactlyMatch[1]!;
    const target = exactlyMatch[3] ? Number(exactlyMatch[3]) : 1;
    const calls = toolCallsByName(toolName);
    return result(criterion, calls.length === target, `${toolName} was called ${calls.length} time(s) (expected ${target})`);
  }

  return result(criterion, false, "Pome does not know how to evaluate this deterministic criterion yet.");
}

function result(criterion: Criterion, passed: boolean, reason: string): CriterionResult {
  return {
    criterion,
    passed,
    skipped: false,
    reason,
  };
}
