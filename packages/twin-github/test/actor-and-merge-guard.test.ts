// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

async function seedBranchAndPR(app: ReturnType<typeof createGitHubCloneApp>, token: string, branch: string) {
  const refResp = await app.request(`${base}/repos/acme/api/git/refs`, withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}` })
  }));
  expect(refResp.status).toBe(201);

  const fileResp = await app.request(`${base}/repos/acme/api/contents/${branch}.md`, withAuth(token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "add note", content: "hi", branch })
  }));
  expect(fileResp.status).toBe(201);

  const prResp = await app.request(`${base}/repos/acme/api/pulls`, withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x", head: branch, base: "main" })
  }));
  expect(prResp.status).toBe(201);
  return (await prResp.json()) as { number: number; user: { login: string } };
}

describe("actor identity via JWT login claim", () => {
  it("POST /pulls persists user_login from session.login", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/from-alice");
    expect(pr.user.login).toBe("alice");
  });

  it("POST /pulls without login claim defaults user_login to pome-agent", async () => {
    const app = createGitHubCloneApp();
    // signTestToken defaults login to "pome-agent" so existing flows keep working.
    const defaultToken = await signTestToken();
    const pr = await seedBranchAndPR(app, defaultToken, "feature/from-default");
    expect(pr.user.login).toBe("pome-agent");
  });
});

describe("merge-guard 403 enforcement", () => {
  it("merge by a collaborator (alice) → 200", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/coll-merge");

    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, withAuth(aliceToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(mergeResp.status).toBe(200);
    await expect(mergeResp.json()).resolves.toMatchObject({ merged: true });
  });

  it("merge by a non-collaborator (mallory) → 403 with GitHub-shaped body", async () => {
    const app = createGitHubCloneApp();
    // PR opened by a collaborator so the PR creation itself succeeds.
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/non-coll-merge");

    const malloryToken = await signTestToken({ login: "mallory" });
    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, withAuth(malloryToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(mergeResp.status).toBe(403);
    const body = await mergeResp.json() as { message: string; documentation_url: string };
    expect(body.message).toMatch(/push access|permission|collaborator|forbidden/i);
    expect(typeof body.documentation_url).toBe("string");

    // PR remains open + unmerged.
    const stateResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}`, withAuth(aliceToken));
    expect(stateResp.status).toBe(200);
    const state = await stateResp.json() as { state: string; merged: boolean };
    expect(state.state).toBe("open");
    expect(state.merged).toBe(false);
  });

  it("merge by a pending invitee → 403", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/pending-merge");
    const defaultToken = await signTestToken();
    const inviteResp = await app.request(`${base}/repos/acme/api/collaborators/pending-user`, withAuth(defaultToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission: "push" })
    }));
    expect(inviteResp.status).toBe(201);

    const pendingToken = await signTestToken({ login: "pending-user" });
    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, withAuth(pendingToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(mergeResp.status).toBe(403);
  });

  it("merge with no Authorization → 401 (unchanged)", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/no-auth-merge");

    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(mergeResp.status).toBe(401);
  });

  it("403 attempt is recorded with status:403, state_mutation:false, error populated", async () => {
    const recorder = createRecorderStore();
    const app = createGitHubCloneApp({ recorder, runId: "run_merge_403_test" });
    const aliceToken = await signTestToken({ login: "alice" });
    const pr = await seedBranchAndPR(app, aliceToken, "feature/recorder-403");

    const malloryToken = await signTestToken({ login: "mallory" });
    const mergeResp = await app.request(`${base}/repos/acme/api/pulls/${pr.number}/merge`, withAuth(malloryToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(mergeResp.status).toBe(403);

    const events = recorder.events();
    const mergeEvent = events.reverse().find((e) => e.method === "PUT" && /\/pulls\/\d+\/merge$/.test(e.path));
    expect(mergeEvent).toBeDefined();
    expect(mergeEvent!.status).toBe(403);
    expect(mergeEvent!.state_mutation).toBe(false);
    expect(mergeEvent!.error).toBeTruthy();
    expect(mergeEvent!.state_delta).toBeNull();
  });
});
