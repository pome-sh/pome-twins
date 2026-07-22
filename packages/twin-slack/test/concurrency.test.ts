import { describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "concurrency" });
}

describe("race condition regression coverage", () => {
  it("allows only one concurrent conversations.create for the same channel name", async () => {
    const app = freshApp();
    const token = await signTestToken();
    const create = () =>
      app.request(
        `${base}/conversations.create`,
        withAuth(token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "race-dupe", is_private: false }),
        })
      );

    // Both responses are HTTP 200 (Slack envelope) — distinguish via body.ok.
    const responses = await Promise.all([create(), create()]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ ok: boolean; error?: string }>;
    for (const r of responses) expect(r.status).toBe(200);
    const okCount = bodies.filter((b) => b.ok === true).length;
    const failCount = bodies.filter((b) => b.ok === false && b.error === "name_taken").length;
    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it("50 parallel chat.postMessage produce unique ts values", async () => {
    const app = freshApp();
    const token = await signTestToken();
    const COUNT = 50;
    const post = () =>
      app.request(
        `${base}/chat.postMessage`,
        withAuth(token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "C_GENERAL", text: "parallel" }),
        })
      );

    const responses = await Promise.all(Array.from({ length: COUNT }, () => post()));
    const tsValues = (
      await Promise.all(
        responses.map(async (r) => {
          expect(r.status).toBe(200);
          return ((await r.json()) as { ts: string }).ts;
        })
      )
    ).sort();
    expect(new Set(tsValues).size).toBe(COUNT);
  });
});
