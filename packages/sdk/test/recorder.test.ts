// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recorderEventSchema } from "@pome-sh/shared-types";
import { createApp } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";
import { toyTwin } from "./_toyTwin.js";

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

async function fetchEvents(app: ReturnType<typeof createApp>): Promise<unknown[]> {
  const res = await app.request(`${base}/_pome/events`, withAuth(token));
  return (await res.json()) as unknown[];
}

describe("recorder middleware emit shape", () => {
  it("emits an event matching recording-spec.md v1.0 for a successful POST", async () => {
    const app = createApp(toyTwin, { seed: { items: [] }, runId: "run_test" });

    await app.request(
      `${base}/items`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: "alpha" }),
      })
    );

    const events = await fetchEvents(app);
    expect(events.length).toBeGreaterThan(0);

    // Every event parses against the canonical Zod schema
    for (const event of events) {
      const parsed = recorderEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    }

    const post = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && (e as { method?: string }).method === "POST"
    );
    expect(post).toBeDefined();
    expect(post).toMatchObject({
      run_id: "run_test",
      twin: "toy",
      method: "POST",
      path: `${base}/items`,
      status: 201,
      state_mutation: true,
      fidelity: "semantic",
      error: null,
    });
    expect(typeof post?.latency_ms).toBe("number");
    expect((post?.latency_ms as number) >= 0).toBe(true);
    expect(typeof post?.request_id).toBe("string");
    expect((post?.request_id as string).startsWith("req_")).toBe(true);
  });

  it("emits state_mutation=false for read-only routes", async () => {
    const app = createApp(toyTwin, { seed: { items: ["x"] } });

    await app.request(`${base}/items`, withAuth(token));

    const events = await fetchEvents(app);
    const get = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && (e as { method?: string }).method === "GET"
    );
    expect(get).toMatchObject({ state_mutation: false, status: 200 });
    expect(get?.request_body).toBeNull();
  });

  it("populates `error` and state_mutation=false when a handler throws", async () => {
    const app = createApp(toyTwin);

    // POST /items with no body → 422 from the user route's manual envelope
    await app.request(
      `${base}/items`,
      withAuth(token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );

    const events = await fetchEvents(app);
    const failed = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && (e as { status?: number }).status === 422
    );
    expect(failed).toBeDefined();
    expect(failed?.state_mutation).toBe(false);
    expect(failed?.error).toBeTypeOf("string");
  });

  it("includes the parsed JSON request_body for POSTs", async () => {
    const app = createApp(toyTwin);

    await app.request(
      `${base}/items`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: "beta" }),
      })
    );

    const events = await fetchEvents(app);
    const post = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && (e as { method?: string }).method === "POST"
    );
    expect(post?.request_body).toEqual({ item: "beta" });
  });
});
