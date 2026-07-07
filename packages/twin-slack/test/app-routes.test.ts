import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const recorder = createRecorderStore();
  const app = createSlackTwinApp({ db, domain, recorder, runId: "routes" });
  return { app, domain, recorder };
}

async function post(app: ReturnType<typeof createSlackTwinApp>, token: string, path: string, body: Record<string, unknown>) {
  return app.request(
    `${base}${path}`,
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("session route coverage", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("covers chat, conversations, users, files, bookmarks, team, pome introspection", async () => {
    const { app, domain, recorder } = freshApp();

    const postMsg = await post(app, token, "/chat.postMessage", { channel: "C_GENERAL", text: "route sweep" });
    expect(postMsg.status).toBe(200);
    const msg = (await postMsg.json()) as { ts: string };

    const update = await post(app, token, "/chat.update", { channel: "C_GENERAL", ts: msg.ts, text: "updated" });
    expect(update.status).toBe(200);

    const schedule = await post(app, token, "/chat.scheduleMessage", {
      channel: "C_GENERAL",
      text: "later",
      post_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(schedule.status).toBe(200);
    const scheduled = (await schedule.json()) as { scheduled_message_id: string };

    const delSched = await post(app, token, "/chat.deleteScheduledMessage", {
      channel: "C_GENERAL",
      scheduled_message_id: scheduled.scheduled_message_id,
    });
    expect(delSched.status).toBe(200);

    const create = await post(app, token, "/conversations.create", { name: "sweep-ch", is_private: false });
    expect(create.status).toBe(200);
    const ch = (await create.json()) as { channel: { id: string } };

    expect((await post(app, token, "/conversations.archive", { channel: ch.channel.id })).status).toBe(200);
    expect((await post(app, token, "/conversations.join", { channel: "C_RANDOM" })).status).toBe(200);
    expect(
      (await post(app, token, "/conversations.invite", { channel: "C_RANDOM", users: "bob" })).status
    ).toBe(200);
    expect((await post(app, token, "/conversations.kick", { channel: "C_RANDOM", user: "bob" })).status).toBe(200);
    expect((await post(app, token, "/conversations.leave", { channel: "C_RANDOM" })).status).toBe(200);
    expect((await post(app, token, "/conversations.open", { users: "alice" })).status).toBe(200);

    expect(
      (await app.request(`${base}/conversations.info?channel=C_GENERAL`, withAuth(token, {}))).status
    ).toBe(200);
    expect(
      (await app.request(`${base}/conversations.members?channel=C_GENERAL`, withAuth(token, {}))).status
    ).toBe(200);

    expect((await post(app, token, "/users.list", {})).status).toBe(200);
    expect((await app.request(`${base}/users.info?user=alice`, withAuth(token, {}))).status).toBe(200);
    expect(
      (await app.request(`${base}/users.lookupByEmail?email=alice@pome-twin.slack.com`, withAuth(token, {}))).status
    ).toBe(200);
    expect(
      (await post(app, token, "/users.profile.set", { user: "alice", profile: JSON.stringify({ status_text: "busy" }) }))
        .status
    ).toBe(200);

    const upload = await post(app, token, "/files.upload", {
      channels: "C_GENERAL",
      filename: "sweep.txt",
      content: "file body",
    });
    expect(upload.status).toBe(200);
    const file = (await upload.json()) as { file: { id: string } };
    expect((await app.request(`${base}/files.info?file=${file.file.id}`, withAuth(token, {}))).status).toBe(200);
    expect((await app.request(`${base}/files.list`, withAuth(token, {}))).status).toBe(200);

    const pinAdd = await post(app, token, "/pins.add", { channel: "C_GENERAL", timestamp: msg.ts });
    expect(pinAdd.status).toBe(200);
    expect((await app.request(`${base}/pins.list?channel=C_GENERAL`, withAuth(token, {}))).status).toBe(200);
    expect((await post(app, token, "/pins.remove", { channel: "C_GENERAL", timestamp: msg.ts })).status).toBe(200);

    const bmAdd = await post(app, token, "/bookmarks.add", {
      channel_id: "C_GENERAL",
      title: "doc",
      link: "https://example.com",
    });
    expect(bmAdd.status).toBe(200);
    const bm = (await bmAdd.json()) as { bookmark: { id: string } };
    expect((await app.request(`${base}/bookmarks.list?channel_id=C_GENERAL`, withAuth(token, {}))).status).toBe(200);
    expect(
      (await post(app, token, "/bookmarks.remove", { channel_id: "C_GENERAL", bookmark_id: bm.bookmark.id })).status
    ).toBe(200);

    expect((await app.request(`${base}/search.messages?query=route`, withAuth(token, {}))).status).toBe(200);
    expect((await app.request(`${base}/team.info`, withAuth(token, {}))).status).toBe(200);
    expect((await app.request(`${base}/_pome/state`, withAuth(token, {}))).status).toBe(200);
    expect((await app.request(`${base}/_pome/events`, withAuth(token, {}))).status).toBe(200);

    const del = await post(app, token, "/chat.delete", { channel: "C_GENERAL", ts: msg.ts });
    expect(del.status).toBe(200);

    expect((await post(app, token, "/files.delete", { file: file.file.id })).status).toBe(200);

    expect(recorder.events().length).toBeGreaterThan(5);
    void domain;
  });
});
