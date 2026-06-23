import { describe, expect, it } from "vitest";
import {
  formatGitHubAccessControlLabel,
  GITHUB_ACCESS_CONTROL_CATALOG,
  GITHUB_ACCESS_CONTROL_CATEGORY_LABELS,
  GITHUB_ACCESS_CONTROL_CATEGORY_ORDER,
  githubAccessControlCatalogSchema,
  groupGitHubAccessControlByCategory,
  summarizeGitHubAccessControlCatalog,
} from "../src/github-access-control.js";

describe("github access-control catalog", () => {
  it("parses the canonical catalog", () => {
    expect(githubAccessControlCatalogSchema.parse(GITHUB_ACCESS_CONTROL_CATALOG)).toEqual(
      GITHUB_ACCESS_CONTROL_CATALOG
    );
  });

  it("covers 52 endpoints (25 v1 + 27 v2)", () => {
    expect(GITHUB_ACCESS_CONTROL_CATALOG.endpoints).toHaveLength(52);
    expect(GITHUB_ACCESS_CONTROL_CATALOG.endpoints.filter((e) => e.v2)).toHaveLength(27);
    expect(GITHUB_ACCESS_CONTROL_CATALOG.endpoints.filter((e) => !e.v2)).toHaveLength(25);
  });

  it("uses unique tool ids", () => {
    const tools = GITHUB_ACCESS_CONTROL_CATALOG.endpoints.map((e) => e.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("groups endpoints by functional cluster, not reversible/irreversible", () => {
    const categories = GITHUB_ACCESS_CONTROL_CATALOG.categories.map((g) => g.category);
    expect(categories).toEqual([
      "issues",
      "issue_comments",
      "pull_requests",
      "branches_files",
      "commits_diffs",
      "milestones",
      "status_checks",
      "tags_releases",
      "labels",
      "collaborators",
    ]);
    for (const group of GITHUB_ACCESS_CONTROL_CATALOG.categories) {
      expect(group.label).toBe(GITHUB_ACCESS_CONTROL_CATEGORY_LABELS[group.category]);
      expect(group.endpoints.every((e) => e.category === group.category)).toBe(true);
    }
  });

  it("places v2 tools in the expected clusters", () => {
    const byCategory = Object.fromEntries(
      GITHUB_ACCESS_CONTROL_CATALOG.categories.map((g) => [g.category, g.endpoints.map((e) => e.tool)])
    );
    expect(byCategory.branches_files).toContain("delete_branch");
    expect(byCategory.status_checks).toContain("create_check_run");
    expect(byCategory.milestones).toContain("create_milestone");
    expect(byCategory.collaborators).toContain("add_collaborator");
  });

  it("rebuilds categories from flat endpoints", () => {
    expect(groupGitHubAccessControlByCategory(GITHUB_ACCESS_CONTROL_CATALOG.endpoints)).toEqual(
      GITHUB_ACCESS_CONTROL_CATALOG.categories
    );
  });

  it("covers every category in the render order", () => {
    const used = new Set(GITHUB_ACCESS_CONTROL_CATALOG.endpoints.map((e) => e.category));
    for (const category of GITHUB_ACCESS_CONTROL_CATEGORY_ORDER) {
      if (used.has(category)) {
        expect(GITHUB_ACCESS_CONTROL_CATALOG.categories.some((g) => g.category === category)).toBe(true);
      }
    }
  });

  it("matches the legacy dashboard default summary (17 allowed / 8 denied of 25)", () => {
    const v1 = {
      ...GITHUB_ACCESS_CONTROL_CATALOG,
      endpoints: GITHUB_ACCESS_CONTROL_CATALOG.endpoints.filter((e) => !e.v2),
      categories: groupGitHubAccessControlByCategory(
        GITHUB_ACCESS_CONTROL_CATALOG.endpoints.filter((e) => !e.v2)
      ),
    };
    expect(summarizeGitHubAccessControlCatalog(v1)).toEqual({ total: 25, allowed: 17, denied: 8 });
  });

  it("formats labels like the hosted Manage UI", () => {
    const listIssues = GITHUB_ACCESS_CONTROL_CATALOG.endpoints.find((e) => e.tool === "list_issues");
    const addComment = GITHUB_ACCESS_CONTROL_CATALOG.endpoints.find((e) => e.tool === "add_issue_comment");
    const checkRun = GITHUB_ACCESS_CONTROL_CATALOG.endpoints.find((e) => e.tool === "create_check_run");
    expect(formatGitHubAccessControlLabel(listIssues!)).toBe("GET listIssues");
    expect(formatGitHubAccessControlLabel(addComment!)).toBe("POST addComment");
    expect(formatGitHubAccessControlLabel(checkRun!)).toBe("POST createCheckRun");
  });
});
