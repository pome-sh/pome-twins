import { describe, expect, it } from "vitest";
import { createRecorder } from "../../src/recorder/recorder.js";
import { createGitHubTwinApp } from "../../src/twin/github/app.js";
import { defaultSeedState } from "../../src/twin/github/domain/seed.js";

function app() {
  const recorder = createRecorder();
  return {
    app: createGitHubTwinApp({ seed: defaultSeedState(), recorder, runId: "test-run" }),
    recorder
  };
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe("GitHub twin endpoints", () => {
  it("serves repository and issue read endpoints", async () => {
    const { app: twin } = app();

    expect((await twin.request("/repos/acme/api")).status).toBe(200);
    expect((await twin.request("/repos/acme/api/issues")).status).toBe(200);
    expect((await twin.request("/repos/acme/api/issues/1")).status).toBe(200);

    const issue = await json(await twin.request("/repos/acme/api/issues/1"));
    expect(issue.title).toContain("500 error");
  });

  it("updates issue state and assignee when the assignee is a collaborator", async () => {
    const { app: twin } = app();

    const response = await twin.request("/repos/acme/api/issues/1", {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", assignee: "alice" }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(200);
    const issue = await json(response);
    expect(issue.state).toBe("closed");
    expect(issue.assignee.login).toBe("alice");
  });

  it("rejects assignment to a non-collaborator", async () => {
    const { app: twin } = app();

    const response = await twin.request("/repos/acme/api/issues/1/assignees", {
      method: "POST",
      body: JSON.stringify({ assignees: ["mallory"] }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ message: "Validation Failed" });
  });

  it("creates comments", async () => {
    const { app: twin } = app();

    const response = await twin.request("/repos/acme/api/issues/1/comments", {
      method: "POST",
      body: JSON.stringify({ body: "I looked at this." }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(201);
    const comment = await json(response);
    expect(comment.body).toBe("I looked at this.");
  });

  it("lists, creates, applies, lists issue labels, and deletes issue labels", async () => {
    const { app: twin } = app();

    expect((await twin.request("/repos/acme/api/labels")).status).toBe(200);

    const create = await twin.request("/repos/acme/api/labels", {
      method: "POST",
      body: JSON.stringify({ name: "urgent", color: "ff0000" }),
      headers: { "content-type": "application/json" }
    });
    expect(create.status).toBe(201);

    const apply = await twin.request("/repos/acme/api/issues/1/labels", {
      method: "POST",
      body: JSON.stringify({ labels: ["urgent"] }),
      headers: { "content-type": "application/json" }
    });
    expect(apply.status).toBe(200);
    expect((await json(apply)).map((label: { name: string }) => label.name)).toContain("urgent");

    const list = await twin.request("/repos/acme/api/issues/1/labels");
    expect(list.status).toBe(200);

    const remove = await twin.request("/repos/acme/api/issues/1/labels/urgent", { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect((await json(remove)).map((label: { name: string }) => label.name)).not.toContain("urgent");
  });

  it("rejects applying a missing label", async () => {
    const { app: twin } = app();

    const response = await twin.request("/repos/acme/api/issues/1/labels", {
      method: "POST",
      body: JSON.stringify({ labels: ["missing"] }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ message: "Validation Failed" });
  });

  it("lists collaborators and adds assignees", async () => {
    const { app: twin } = app();

    const collaborators = await twin.request("/repos/acme/api/collaborators");
    expect(collaborators.status).toBe(200);
    expect((await json(collaborators)).map((user: { login: string }) => user.login)).toEqual(["alice", "bob"]);

    const assign = await twin.request("/repos/acme/api/issues/1/assignees", {
      method: "POST",
      body: JSON.stringify({ assignees: ["bob"] }),
      headers: { "content-type": "application/json" }
    });
    expect(assign.status).toBe(201);
    expect((await json(assign)).assignee.login).toBe("bob");
  });

  it("returns GitHub-shaped errors for missing resources and malformed JSON", async () => {
    const { app: twin } = app();

    expect((await twin.request("/repos/nope/api")).status).toBe(404);

    const malformed = await twin.request("/repos/acme/api/issues/1/comments", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" }
    });
    expect(malformed.status).toBe(400);
  });

  it("rejects unsupported endpoints loudly and records requests", async () => {
    const { app: twin, recorder } = app();

    const response = await twin.request("/repos/acme/api/pulls");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ fidelity: "unsupported" });
    expect(recorder.events()).toHaveLength(1);
    expect(recorder.events()[0]).toMatchObject({
      method: "GET",
      path: "/repos/acme/api/pulls",
      fidelity: "unsupported"
    });
  });
});
