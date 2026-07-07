// SPDX-License-Identifier: Apache-2.0
import { parseSeed, seedSchema } from "@pome-sh/twin-github";

// Bundled scenario sidecars and legacy compile output used singular `assignee`
// on issues; @pome-sh/twin-github's seedSchema expects `assignees[]`. Zod strips
// unknown keys, so migrate before parse.
export function normalizeLegacyGitHubSeed(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const seed = input as Record<string, unknown>;
  if (!Array.isArray(seed.repositories)) return input;

  return {
    ...seed,
    repositories: seed.repositories.map((repo) => {
      if (!repo || typeof repo !== "object" || Array.isArray(repo)) return repo;
      const record = repo as Record<string, unknown>;
      if (!Array.isArray(record.issues)) return repo;
      return {
        ...record,
        issues: record.issues.map((issue) => normalizeLegacyIssueAssignee(issue)),
      };
    }),
  };
}

function normalizeLegacyIssueAssignee(issue: unknown): unknown {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
  const record = issue as Record<string, unknown>;
  if (!("assignee" in record) || "assignees" in record) return issue;

  const { assignee, ...rest } = record;
  if (assignee === null || assignee === undefined || assignee === "") {
    return { ...rest, assignees: [] };
  }
  if (typeof assignee === "string") {
    return { ...rest, assignees: [assignee] };
  }
  return issue;
}

export function parseGitHubSeedState(input: unknown): ReturnType<typeof seedSchema.parse> {
  const seed = seedSchema.parse(parseSeed(normalizeLegacyGitHubSeed(input)));
  if (seed.repositories.length === 0) {
    throw new Error("GitHub seed must contain at least one repository");
  }
  return seed;
}
