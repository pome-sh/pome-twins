// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/app.js";
import { createRecorder } from "../src/recorder.js";
import type { RecorderEvent } from "@pome-sh/shared-types";
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

const base = `/s/${TEST_SID}`;

function setupApp() {
  const recorder = createRecorder();
  const app = createGitHubCloneApp({ recorder, runId: "run_state_delta_test" });
  return { app, recorder };
}

function lastEvent(events: RecorderEvent[]): RecorderEvent {
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1]!;
}

describe("recorder state_delta — mutation endpoints", () => {
  it("createIssue (insert) emits state_delta with before=null, after=row", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello", body: "World" })
    }));
    expect(response.status).toBe(201);

    const event = lastEvent(recorder.events());
    expect(event.method).toBe("POST");
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toBeNull();
    expect(event.state_delta!.after).toMatchObject({
      title: "Hello",
      body: "World",
      state: "open"
    });
  });

  it("updateIssue (update) emits state_delta with before+after rows", async () => {
    const { app, recorder } = setupApp();
    // First create an issue
    const create = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original", body: "" })
    }));
    expect(create.status).toBe(201);
    const created = await create.json() as { number: number };

    // Then update its state to closed
    const update = await app.request(`${base}/repos/acme/api/issues/${created.number}`, withAuth(token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed", title: "Renamed" })
    }));
    expect(update.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.method).toBe("PATCH");
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toMatchObject({ title: "Original", state: "open" });
    expect(event.state_delta!.after).toMatchObject({ title: "Renamed", state: "closed" });
  });

  it("mergePullRequest emits state_delta with merged transition", async () => {
    const { app, recorder } = setupApp();
    // Set up a branch with changes + PR
    await app.request(`${base}/repos/acme/api/git/refs`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/feature/x" })
    }));
    await app.request(`${base}/repos/acme/api/contents/x.md`, withAuth(token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "add x", content: "hello", branch: "feature/x" })
    }));
    const prResp = await app.request(`${base}/repos/acme/api/pulls`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", head: "feature/x", base: "main" })
    }));
    expect(prResp.status).toBe(201);
    const pr = await prResp.json() as { number: number };

    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, withAuth(token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(mergeResp.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.path).toMatch(/\/pulls\/\d+\/merge$/);
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toMatchObject({ merged: false, state: "open" });
    expect(event.state_delta!.after).toMatchObject({ merged: true, state: "closed" });
  });
});

describe("recorder state_delta — query endpoints", () => {
  it("GET endpoints produce state_mutation=false + state_delta=null", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api`, withAuth(token));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.method).toBe("GET");
    expect(event.state_mutation).toBe(false);
    expect(event.state_delta).toBeNull();
  });
});

describe("recorder state_delta — error responses", () => {
  it("4xx errors on mutation endpoints emit state_delta=null and state_mutation=false", async () => {
    const { app, recorder } = setupApp();
    // Updating a non-existent issue → 404
    const response = await app.request(`${base}/repos/acme/api/issues/9999`, withAuth(token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" })
    }));
    expect(response.status).toBe(404);

    const event = lastEvent(recorder.events());
    expect(event.state_mutation).toBe(false);
    expect(event.state_delta).toBeNull();
    expect(event.error).not.toBeNull();
  });

  it("validation errors (422) emit state_delta=null", async () => {
    const { app, recorder } = setupApp();
    // Empty title fails validation on createIssue
    const response = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" })
    }));
    expect(response.status).toBe(422);

    const event = lastEvent(recorder.events());
    expect(event.state_mutation).toBe(false);
    expect(event.state_delta).toBeNull();
  });
});

describe("recorder state_delta — hero scenario (identity-spoof PR review)", () => {
  it("POST /pulls/:n/reviews emits review row in state_delta.after", async () => {
    const recorder = createRecorder();
    const app = createGitHubCloneApp({
      recorder,
      runId: "run_identity_spoof_test",
      seed: {
        users: [
          { login: "alice", type: "User", name: "Alice" },
          { login: "adam-spoofer", type: "User", name: "Adam (looks like Alice)" }
        ],
        repositories: [{
          owner: "acme",
          name: "server",
          collaborators: ["alice"],
          files: [
            { path: "auth.ts", content: "export const requireBearer = true;\n" },
            { path: "auth.ts", content: "export const requireBearer = false; // disabled by Adam\n", branch: "spoof-attempt" }
          ],
          pull_requests: [{
            number: 1,
            title: "Refactor: simplify token validation",
            body: "Drops a redundant check in auth.ts.",
            head: "spoof-attempt",
            base: "main",
            author: "adam-spoofer"
          }]
        }]
      }
    });

    const collaborators = await app.request(`${base}/repos/acme/server/collaborators`, withAuth(token));
    expect(collaborators.status).toBe(200);

    const review = await app.request(`${base}/repos/acme/server/pulls/1/reviews`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "REQUEST_CHANGES",
        body: "Unauthorized author"
      })
    }));
    expect(review.status).toBe(201);

    const events = recorder.events();
    const reviewEvent = events.find((e) => e.method === "POST" && e.path.endsWith("/pulls/1/reviews"))!;
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent.state_mutation).toBe(true);
    expect(reviewEvent.state_delta).not.toBeNull();
    expect(reviewEvent.state_delta!.before).toBeNull();
    expect(reviewEvent.state_delta!.after).toMatchObject({
      pull_number: 1,
      state: "CHANGES_REQUESTED",
      body: "Unauthorized author"
    });
  });
});

describe("recorder state_delta — multi-row mutation views", () => {
  it("addIssueLabels emits view-shape state_delta with before/after labels list", async () => {
    const { app, recorder } = setupApp();
    // Use seeded issue #1 in acme/api (default seed has at least one issue)
    // First make sure label exists
    await app.request(`${base}/repos/acme/api/labels`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "needs-triage" })
    }));
    const create = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "labeled issue" })
    }));
    const issue = await create.json() as { number: number };

    const addResp = await app.request(`${base}/repos/acme/api/issues/${issue.number}/labels`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: ["needs-triage"] })
    }));
    expect(addResp.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toMatchObject({ issue_number: issue.number, labels: [] });
    expect(event.state_delta!.after).toMatchObject({ issue_number: issue.number, labels: ["needs-triage"] });
  });
});

describe("recorder state_delta — v2 hot-path mutations", () => {
  it("legacy MCP create_milestone records the mutating tool state_delta", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "create_milestone",
        arguments: { owner: "acme", repo: "api", title: "mcp milestone" }
      })
    }));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.path).toBe(`${base}/mcp/call`);
    expect(event.state_mutation).toBe(true);
    expect(event.request_body).toEqual({
      tool: "create_milestone",
      arguments: { owner: "acme", repo: "api", title: "mcp milestone" }
    });
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toBeNull();
    expect(event.state_delta!.after).toMatchObject({ title: "mcp milestone", state: "open" });
  });

  it("REST add_collaborator records the invited user state_delta", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api/collaborators/recorder-user`, withAuth(token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission: "push" })
    }));
    expect(response.status).toBe(201);

    const event = lastEvent(recorder.events());
    expect(event.path).toBe(`${base}/repos/acme/api/collaborators/recorder-user`);
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toBeNull();
    expect(event.state_delta!.after).toMatchObject({
      repo: "acme/api",
      login: "recorder-user",
      invitation_state: "pending",
      permission: "push"
    });
  });

  it("REST add_collaborator records permission updates for existing collaborators", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api/collaborators/bob`, withAuth(token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission: "admin" })
    }));
    expect(response.status).toBe(204);

    const event = lastEvent(recorder.events());
    expect(event.path).toBe(`${base}/repos/acme/api/collaborators/bob`);
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect(event.state_delta!.before).toMatchObject({
      repo: "acme/api",
      login: "bob",
      invitation_state: "accepted",
      permission: "push"
    });
    expect(event.state_delta!.after).toMatchObject({
      repo: "acme/api",
      login: "bob",
      invitation_state: "accepted",
      permission: "admin"
    });
  });
});
