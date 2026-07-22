import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

/** Frozen Linear MCP launch tool order (Gate-1 Wave 4 — Gate 0 + delete_comment/documents). */
const LINEAR_LAUNCH_TOOLS = [
  "list_issues",
  "get_issue",
  "save_issue",
  "list_comments",
  "save_comment",
  "delete_comment",
  "list_teams",
  "get_team",
  "list_users",
  "get_user",
  "list_issue_statuses",
  "get_issue_status",
  "list_issue_labels",
  "create_issue_label",
  "list_projects",
  "get_project",
  "save_project",
  "list_cycles",
  "search_documentation",
  "list_documents",
  "get_document",
  "save_document",
];

test("MCP canonical launchToolOrder matches Gate-1 freeze", () => {
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  assert.equal(canonical.meta.launchToolCount, LINEAR_LAUNCH_TOOLS.length);
  assert.equal(LINEAR_LAUNCH_TOOLS.length, 22);
  assert.deepEqual(canonical.meta.launchToolOrder, LINEAR_LAUNCH_TOOLS);
  const names = canonical.result.tools.map((t) => t.name);
  assert.equal(names.length, LINEAR_LAUNCH_TOOLS.length);
  assert.deepEqual(names, LINEAR_LAUNCH_TOOLS);
  for (const tool of canonical.result.tools) {
    assert.ok(tool.inputSchema, tool.name);
    assert.ok(tool.description, tool.name);
  }
});

test("graphql-surface freezes launch queries and mutations", () => {
  const surface = readJson("fixtures/graphql-surface.json");
  assert.ok(surface.queries.includes("viewer"));
  assert.ok(surface.queries.includes("issues"));
  assert.ok(surface.mutations.includes("issueCreate"));
  assert.ok(surface.mutations.includes("issueAddLabel"));
  assert.ok(surface.mutations.includes("webhookCreate"));
  assert.ok(surface.mutations.includes("commentDelete"));
});
