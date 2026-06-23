import { beforeAll, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/app.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { createRecorder } from "../src/recorder.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";
import type { Recorder } from "../src/types.js";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

type Harness = {
  app: ReturnType<typeof createSlackTwinApp>;
  recorder: Recorder;
  token: string;
};

async function freshHarness(): Promise<Harness> {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const recorder = createRecorder();
  const app = createSlackTwinApp({ db, domain, recorder, runId: "delta-test" });
  const token = await signTestToken();
  return { app, recorder, token };
}

async function postJson(h: Harness, path: string, body: Record<string, unknown>) {
  const res = await h.app.request(
    `/s/${TEST_SID}${path}`,
    withAuth(h.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return res;
}

function lastEvent(h: Harness) {
  const events = h.recorder.events();
  return events[events.length - 1];
}

describe("recorder state-delta per mutation", () => {
  it("chat.postMessage: before=null, after=full row", async () => {
    const h = await freshHarness();
    const res = await postJson(h, "/chat.postMessage", { channel: "C_GENERAL", text: "x" });
    expect(res.status).toBe(200);
    const ev = lastEvent(h)!;
    expect(ev.state_mutation).toBe(true);
    expect(ev.state_delta).not.toBeNull();
    expect(ev.state_delta!.before).toBeNull();
    expect((ev.state_delta!.after as { text: string }).text).toBe("x");
  });

  it("chat.delete: before=full row, after=null", async () => {
    const h = await freshHarness();
    const post = (await (await postJson(h, "/chat.postMessage", { channel: "C_GENERAL", text: "doomed" })).json()) as { ts: string };
    const res = await postJson(h, "/chat.delete", { channel: "C_GENERAL", ts: post.ts });
    expect(res.status).toBe(200);
    const ev = lastEvent(h)!;
    expect(ev.state_delta!.before).not.toBeNull();
    expect(ev.state_delta!.after).toBeNull();
  });

  it("conversations.create: before=null, after=channel row", async () => {
    const h = await freshHarness();
    await postJson(h, "/conversations.create", { name: "newroom" });
    const ev = lastEvent(h)!;
    expect(ev.state_delta!.before).toBeNull();
    expect((ev.state_delta!.after as { name: string }).name).toBe("newroom");
  });

  it("reactions.add → state_delta.after has the row, reactions.remove → after=null", async () => {
    const h = await freshHarness();
    const post = (await (await postJson(h, "/chat.postMessage", { channel: "C_GENERAL", text: "y" })).json()) as { ts: string };
    await postJson(h, "/reactions.add", { channel: "C_GENERAL", timestamp: post.ts, name: "fire" });
    expect(lastEvent(h)!.state_delta!.after).not.toBeNull();
    await postJson(h, "/reactions.remove", { channel: "C_GENERAL", timestamp: post.ts, name: "fire" });
    expect(lastEvent(h)!.state_delta!.after).toBeNull();
  });

  it("read-only endpoint emits state_delta:null and state_mutation:false", async () => {
    const h = await freshHarness();
    await h.app.request(`/s/${TEST_SID}/conversations.list`, withAuth(h.token, {}));
    const ev = lastEvent(h)!;
    expect(ev.state_mutation).toBe(false);
    expect(ev.state_delta).toBeNull();
  });

  it("Slack-envelope error emits state_delta:null and error set", async () => {
    const h = await freshHarness();
    const res = await postJson(h, "/conversations.create", { name: "general" });
    // HTTP 200 + ok:false envelope; recorder still emits status 200 with error set.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("name_taken");
    const ev = lastEvent(h)!;
    expect(ev.state_delta).toBeNull();
    expect(ev.state_mutation).toBe(false);
    expect(ev.error).toBe("name_taken");
  });

  it("conversations.invite emits view-shape delta with members lists", async () => {
    const h = await freshHarness();
    await postJson(h, "/conversations.create", { name: "private", is_private: true });
    const listRes = await h.app.request(
      `/s/${TEST_SID}/conversations.list?types=private_channel`,
      withAuth(h.token, {})
    );
    const list = (await listRes.json()) as { channels: Array<{ id: string }> };
    const target = list.channels.find((c) => c.id.startsWith("G"));
    expect(target).toBeDefined();
    await postJson(h, "/conversations.invite", { channel: target!.id, users: "U_ALICE,U_BOB" });
    const ev = lastEvent(h)!;
    const before = ev.state_delta!.before as { members: string[] };
    const after = ev.state_delta!.after as { members: string[] };
    expect(after.members.length).toBeGreaterThan(before.members.length);
  });

  it("pins.add → after row; pins.remove → after null", async () => {
    const h = await freshHarness();
    const post = (await (await postJson(h, "/chat.postMessage", { channel: "C_GENERAL", text: "p" })).json()) as { ts: string };
    await postJson(h, "/pins.add", { channel: "C_GENERAL", timestamp: post.ts });
    expect(lastEvent(h)!.state_delta!.after).not.toBeNull();
    await postJson(h, "/pins.remove", { channel: "C_GENERAL", timestamp: post.ts });
    expect(lastEvent(h)!.state_delta!.after).toBeNull();
  });
});
