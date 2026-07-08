import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { GITHUB_ACCESS_CONTROL_CATALOG, summarizeGitHubAccessControlCatalog } from "@pome-sh/shared-types";
import { assertAccessControlCatalogMatchesTools } from "../src/access-control.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

describe("access-control catalog", () => {
  it("matches every catalog tool to an MCP tool definition", () => {
    expect(() => assertAccessControlCatalogMatchesTools()).not.toThrow();
  });

  it("includes all 27 v2 hot-path tools", () => {
    const v2Tools = GITHUB_ACCESS_CONTROL_CATALOG.endpoints.filter((e) => e.v2).map((e) => e.tool).sort();
    expect(v2Tools).toEqual([
      "add_collaborator",
      "add_reply_to_pull_request_comment",
      "compare_commits",
      "create_check_run",
      "create_commit_status",
      "create_milestone",
      "create_pull_request_review_comment",
      "create_release",
      "delete_branch",
      "delete_file",
      "delete_issue_comment",
      "delete_milestone",
      "get_branch",
      "get_combined_status_for_ref",
      "get_commit",
      "get_latest_release",
      "get_me",
      "get_pull_request_commits",
      "get_pull_request_diff",
      "list_branches",
      "list_check_runs_for_ref",
      "list_milestones",
      "list_releases",
      "list_tags",
      "update_issue_comment",
      "update_milestone",
      "update_pull_request",
    ].sort());
  });

  it("reports 52-endpoint default summary on /healthz", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("http://pome.local/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_control: ReturnType<typeof summarizeGitHubAccessControlCatalog>;
    };
    expect(body.access_control).toEqual(summarizeGitHubAccessControlCatalog());
    expect(body.access_control.total).toBe(52);
  });

  it("serves the full catalog at /_pome/access-control", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request(`http://pome.local/s/${TEST_SID}/_pome/access-control`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      endpoints: Array<{ tool: string }>;
      categories: Array<{ category: string; label: string; endpoints: Array<{ tool: string }> }>;
      summary: ReturnType<typeof summarizeGitHubAccessControlCatalog>;
    };
    expect(body.version).toBe(2);
    expect(body.endpoints).toHaveLength(52);
    expect(body.summary.total).toBe(52);
    expect(body.endpoints.some((e: { tool: string }) => e.tool === "create_check_run")).toBe(true);
    expect(body.categories).toHaveLength(10);
    expect(body.categories.find((g: { category: string }) => g.category === "status_checks")?.endpoints.some(
      (e: { tool: string }) => e.tool === "create_check_run"
    )).toBe(true);
  });
});
