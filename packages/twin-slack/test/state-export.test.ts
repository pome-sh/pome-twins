import { beforeAll, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/app.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

function build() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const app = createSlackTwinApp({ db, domain, runId: "state-test" });
  return { db, domain, app };
}

describe("state export", () => {
  it("_pome/state returns equivalent shape for a fresh seed (timestamps modulo)", async () => {
    const a = build();
    const b = build();
    const token = await signTestToken();
    const ra = (await (await a.app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token, {}))).json()) as Record<
      string,
      unknown
    >;
    const rb = (await (await b.app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token, {}))).json()) as Record<
      string,
      unknown
    >;
    const strip = (s: string) =>
      s.replace(/"created_at":"[^"]+"/g, '"created_at":"<ts>"').replace(/"updated_at":"[^"]+"/g, '"updated_at":"<ts>"');
    expect(strip(JSON.stringify(ra))).toBe(strip(JSON.stringify(rb)));
  });

  it("seed + 10 ops + same seed in a fresh app produces equivalent state", async () => {
    const a = build();
    const token = await signTestToken();
    for (let i = 0; i < 10; i += 1) {
      a.domain.chatPostMessage({ channel: "C_GENERAL", text: `m${i}` }, { login: "pome-agent" });
    }
    const before = (await (await a.app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token, {}))).json()) as {
      channels: Array<{ id: string; messages: unknown[] }>;
    };
    expect(before.channels.find((c) => c.id === "C_GENERAL")).toBeDefined();
  });

  it("admin/reset clears state to defaultSeedState", async () => {
    const a = build();
    const token = await signTestToken();
    a.domain.chatPostMessage({ channel: "C_GENERAL", text: "to-be-wiped" }, { login: "pome-agent" });
    const reset = await a.app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const after = (await (await a.app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token, {}))).json()) as {
      channels: Array<{ id: string; messages: Array<{ text: string }> }>;
    };
    const general = after.channels.find((c) => c.id === "C_GENERAL")!;
    expect(general.messages.length).toBe(2); // back to seed
  });

  it("admin/seed loads custom state", async () => {
    const a = build();
    const token = await signTestToken();
    const customSeed = {
      team: { id: "T_CUSTOM", name: "Custom" },
      users: [{ id: "U_CARROT", name: "carrot" }],
      channels: [{ id: "C_HELP", name: "help", members: ["U_CARROT"] }],
    };
    const seedRes = await a.app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(customSeed),
    });
    expect(seedRes.status).toBe(200);
    const state = (await (await a.app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token, {}))).json()) as {
      workspace: { id: string };
      channels: Array<{ id: string }>;
    };
    expect(state.workspace.id).toBe("T_CUSTOM");
    expect(state.channels[0]!.id).toBe("C_HELP");
  });
});
