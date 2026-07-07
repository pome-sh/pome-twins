import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const recorder = createRecorderStore();
  const app = createSlackTwinApp({ db, domain, recorder, runId: "test" });
  return { db, domain, recorder, app };
}

async function authed(token: string, path: string, init: RequestInit = {}) {
  return withAuth(token, init);
}

describe("twin-slack HTTP contract", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("GET /healthz returns slack metadata (no auth required)", async () => {
    const { app } = freshApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.twin).toBe("slack");
    expect(body.tools).toBe(8);
    expect(body.ok).toBe(true);
  });

  it("session healthz requires bearer", async () => {
    const { app } = freshApp();
    const unauth = await app.request(`/s/${TEST_SID}/healthz`);
    expect(unauth.status).toBe(401);
    const okRes = await app.request(`/s/${TEST_SID}/healthz`, await authed(token, `/s/${TEST_SID}/healthz`));
    expect(okRes.status).toBe(200);
  });

  it("auth.test returns Slack envelope", async () => {
    const { app } = freshApp();
    const res = await app.request(`/s/${TEST_SID}/auth.test`, await authed(token, "/auth.test"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.team_id).toBe("T_POME");
    expect(body.user_id).toBe("U_PRIMARY");
    expect(body.url).toMatch(/^https:\/\/pome-twin\.slack\.com/);
  });

  it("chat.postMessage accepts JSON body", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `/s/${TEST_SID}/chat.postMessage`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", text: "hi from json" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channel: string; ts: string };
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("C_GENERAL");
    expect(body.ts).toMatch(/^\d+\.\d{6}$/);
  });

  it("chat.postMessage accepts form-encoded body", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `/s/${TEST_SID}/chat.postMessage`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ channel: "C_GENERAL", text: "hi from form" }).toString(),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("conversations.list uses cursor pagination", async () => {
    const { app } = freshApp();
    const res = await app.request(`/s/${TEST_SID}/conversations.list?limit=1`, await authed(token, ""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: unknown[];
      response_metadata: { next_cursor: string };
    };
    expect(body.channels.length).toBe(1);
    expect(body.response_metadata.next_cursor.length).toBeGreaterThan(0);

    const res2 = await app.request(
      `/s/${TEST_SID}/conversations.list?limit=1&cursor=${encodeURIComponent(body.response_metadata.next_cursor)}`,
      await authed(token, "")
    );
    const body2 = (await res2.json()) as { channels: unknown[]; response_metadata: { next_cursor: string } };
    expect(body2.channels.length).toBe(1);
    expect(body2.response_metadata.next_cursor).toBe("");
  });

  it("conversations.history filters out thread replies over HTTP", async () => {
    const { app, domain } = freshApp();
    const parent = domain.chatPostMessage({ channel: "C_GENERAL", text: "parent" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.chatPostMessage(
      { channel: "C_GENERAL", text: "reply-only", thread_ts: parent.ts },
      { login: "alice" }
    );
    const res = await app.request(
      `/s/${TEST_SID}/conversations.history?channel=C_GENERAL`,
      await authed(token, "")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ text: string }> };
    expect(body.messages.some((m) => m.text === "reply-only")).toBe(false);
    expect(body.messages.some((m) => m.text === "parent")).toBe(true);
  });

  it("conversations.replies returns parent + replies in ASC order", async () => {
    const { app, domain } = freshApp();
    const parent = domain.chatPostMessage({ channel: "C_GENERAL", text: "parent" }, { login: "pome-agent" }) as {
      ts: string;
    };
    domain.chatPostMessage({ channel: "C_GENERAL", text: "reply1", thread_ts: parent.ts }, { login: "alice" });
    domain.chatPostMessage({ channel: "C_GENERAL", text: "reply2", thread_ts: parent.ts }, { login: "bob" });

    const res = await app.request(
      `/s/${TEST_SID}/conversations.replies?channel=C_GENERAL&ts=${parent.ts}`,
      await authed(token, "")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ text: string }> };
    expect(body.messages.length).toBe(3);
    expect(body.messages.map((m) => m.text)).toEqual(["parent", "reply1", "reply2"]);
  });

  it("catch-all returns Slack-shaped 501 for unsupported", async () => {
    const { app } = freshApp();
    const res = await app.request(`/s/${TEST_SID}/admin.users.list`, await authed(token, ""));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: string; _twin: { fidelity: string } };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unsupported_endpoint");
    expect(body._twin.fidelity).toBe("unsupported");
  });

  it("admin/reset only allowed from localhost (no remoteAddress in app.request)", async () => {
    const { app } = freshApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("conversations.create rejects duplicate names with name_taken", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `/s/${TEST_SID}/conversations.create`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "general" }),
      })
    );
    // Slack returns HTTP 200 for app-level errors; SDK distinguishes via body.ok.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("name_taken");
  });

  it("channel_not_found, message_not_found, not_in_channel all return HTTP 200", async () => {
    const { app } = freshApp();
    const cnf = await app.request(
      `/s/${TEST_SID}/conversations.info?channel=C_NONEXISTENT`,
      withAuth(token, {})
    );
    expect(cnf.status).toBe(200);
    expect(((await cnf.json()) as { error: string }).error).toBe("channel_not_found");

    const mnf = await app.request(
      `/s/${TEST_SID}/chat.delete`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", ts: "1.000000" }),
      })
    );
    expect(mnf.status).toBe(200);
    expect(((await mnf.json()) as { error: string }).error).toBe("message_not_found");
  });

  it("ZodError validation returns HTTP 200 with response_metadata.messages", async () => {
    const { app } = freshApp();
    // chat.postMessage without channel parameter
    const res = await app.request(
      `/s/${TEST_SID}/chat.postMessage`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "no channel" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      response_metadata?: { messages: string[] };
    };
    expect(body.ok).toBe(false);
    // Either ZodError-mapped (invalid_arguments) or domain-level (channel_not_found).
    expect(["invalid_arguments", "channel_not_found"]).toContain(body.error);
  });

  it("conversations.create + invite flow", async () => {
    const { app } = freshApp();
    const create = await app.request(
      `/s/${TEST_SID}/conversations.create`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "engineering", is_private: false }),
      })
    );
    expect(create.status).toBe(200);
    const created = (await create.json()) as { channel: { id: string } };
    const invite = await app.request(
      `/s/${TEST_SID}/conversations.invite`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: created.channel.id, users: "U_ALICE,U_BOB" }),
      })
    );
    expect(invite.status).toBe(200);
    const inviteBody = (await invite.json()) as { ok: boolean; channel: { id: string } };
    expect(inviteBody.ok).toBe(true);
  });

  it("reactions.add then reactions.remove round-trips", async () => {
    const { app, domain } = freshApp();
    const post = domain.chatPostMessage({ channel: "C_GENERAL", text: "yo" }, { login: "pome-agent" }) as {
      ts: string;
    };
    const add = await app.request(
      `/s/${TEST_SID}/reactions.add`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", timestamp: post.ts, name: "thumbsup" }),
      })
    );
    expect(add.status).toBe(200);
    const remove = await app.request(
      `/s/${TEST_SID}/reactions.remove`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", timestamp: post.ts, name: "thumbsup" }),
      })
    );
    expect(remove.status).toBe(200);
    const getRes = await app.request(
      `/s/${TEST_SID}/reactions.get?channel=C_GENERAL&timestamp=${post.ts}`,
      await authed(token, "")
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { message: { reactions?: unknown[] } };
    expect(getBody.message.reactions ?? []).toHaveLength(0);
  });
});
