// SPDX-License-Identifier: Apache-2.0
//
// Wave 4 Gate-1: estimate/parent/relations, threaded comments, documents.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_EMAIL,
  LinearDomain,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

function fresh() {
  const db = openLinearTwinDatabase(":memory:");
  const domain = new LinearDomain(db);
  domain.seed(testSeed());
  return domain;
}

describe("Wave 4 Gate-1 domain surfaces", () => {
  it("sets estimate, parentId, and append-only relations", async () => {
    const domain = fresh();
    const team = domain.getTeam("ENG")!;
    const parent = await domain.createIssue(
      { teamId: team.id, title: "Epic", estimate: 8 },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(parent.estimate).toBe(8);

    const child = await domain.createIssue(
      {
        teamId: team.id,
        title: "Story",
        parentId: parent.id,
        blockedBy: [parent.identifier],
        relatedTo: [parent.id],
      },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(child.parentId).toBe(parent.id);
    expect(domain.listIssueRelations(child.id)).toEqual({
      blocks: [],
      blockedBy: [parent.identifier],
      relatedTo: [parent.identifier],
    });

    await domain.updateIssue(child.id, { blocks: [parent.identifier] }, { email: DEFAULT_LINEAR_EMAIL });
    expect(domain.listIssueRelations(child.id).blocks).toEqual([parent.identifier]);
  });

  it("threads comments via parentId and deletes the full reply tree", async () => {
    const domain = fresh();
    const issue = domain.getIssue("issue_todo")!;
    const root = await domain.createComment(
      { issueId: issue.id, body: "Root" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    const reply = await domain.createComment(
      { parentId: root.id, body: "Reply" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    const nested = await domain.createComment(
      { parentId: reply.id, body: "Nested" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(reply.parentId).toBe(root.id);
    expect(nested.parentId).toBe(reply.id);
    expect(reply.issueId).toBe(issue.id);

    await domain.deleteComment(reply.id, { email: DEFAULT_LINEAR_EMAIL });
    expect(domain.getComment(reply.id)).toBeNull();
    expect(domain.getComment(nested.id)).toBeNull();
    expect(domain.getComment(root.id)).not.toBeNull();

    const sibling = await domain.createComment(
      { parentId: root.id, body: "Sibling" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    const deep = await domain.createComment(
      { parentId: sibling.id, body: "Deep" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    await domain.deleteComment(root.id, { email: DEFAULT_LINEAR_EMAIL });
    expect(domain.getComment(root.id)).toBeNull();
    expect(domain.getComment(sibling.id)).toBeNull();
    expect(domain.getComment(deep.id)).toBeNull();
  });

  it("persists documents with exactly one parent", () => {
    const domain = fresh();
    const doc = domain.createDocument(
      { title: "Runbook", content: "Do the thing", team: "ENG" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(doc.teamId).toBe(domain.getTeam("ENG")!.id);
    expect(domain.getDocument(doc.slug)?.title).toBe("Runbook");

    const updated = domain.updateDocument(
      doc.id,
      { content: "Updated" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(updated.content).toBe("Updated");

    const project = domain.createProject(
      { name: "Docs", teamId: domain.getTeam("ENG")!.id },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(() =>
      domain.createDocument(
        { title: "Bad", team: "ENG", project: project.id },
        { email: DEFAULT_LINEAR_EMAIL }
      )
    ).toThrow(/Exactly one parent/);
  });
});
