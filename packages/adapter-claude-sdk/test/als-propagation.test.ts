// SPDX-License-Identifier: Apache-2.0
//
// Regression test for FDRS-322's silent-failure mode. The bug: ALS context
// could be lost across chained `await` boundaries inside a tool handler,
// causing `x-pome-correlation-id` to land on outgoing twin requests as
// `null` (or absent) instead of the handler's `tool_call_id`. Earlier tests
// asserted only "header present", which masked the regression.
//
// This test fails LOUDLY by:
//   1. Capturing the live tool_call_id from ALS at handler entry.
//   2. Forcing two microtask hops (chained awaits).
//   3. Issuing a fetch() to an allowlisted twin host.
//   4. Asserting exact equality between the captured id and the outgoing
//      header value — any drift, loss, or `undefined` flunks the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_SCHEMA = {} as never;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
  ) => ({ name, description, schema, handler }),
  query: () => (async function* () {})(),
  HOOK_EVENTS: [],
}));

const ENV_KEYS = ["POME_TWIN_BASE_URL", "POME_ADAPTER_SIGNALS_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.POME_TWIN_BASE_URL = "http://127.0.0.1:3333";
  delete process.env.POME_ADAPTER_SIGNALS_PATH;

  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = (h as Record<string, string>)[k]!;
    fetchCalls.push({ url, headers });
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  const { _resetInitForTest } = await import("../src/init.js");
  _resetInitForTest();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("ALS propagation across chained awaits (FDRS-322 regression)", () => {
  it("outgoing fetch carries the SAME tool_call_id that the handler read at entry — survives two microtask hops", async () => {
    const { withPome, tool } = await import("../src/index.js");
    const { currentToolCallId } = await import("../src/als.js");
    withPome();

    let idAtEntry: string | null = null;

    const t = tool(
      "two_hop",
      "Reads tool_call_id at entry, hops twice, then fetches.",
      FAKE_SCHEMA,
      async () => {
        idAtEntry = currentToolCallId();
        // Hop 1 — microtask boundary.
        await new Promise((r) => setTimeout(r, 0));
        // Hop 2 — a second await, which is where ALS leakage has bitten
        // in some runtime configurations even when one hop survives.
        await new Promise((r) => setTimeout(r, 0));
        await globalThis.fetch("http://127.0.0.1:3333/v1/repos/acme/api/issues");
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    await (t as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> }).handler(
      {},
      {},
    );

    // Loud failure on every regression mode:
    //   - idAtEntry null → ALS never set
    //   - fetchCalls empty → handler didn't run
    //   - header undefined → fetch hook didn't fire
    //   - header !== idAtEntry → ALS context drifted across hops
    expect(idAtEntry).toMatch(/^tlc_/);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.headers["x-pome-correlation-id"]).toBe(idAtEntry);
  });

  it("nested awaits inside Promise.all() still propagate the same tool_call_id", async () => {
    const { withPome, tool } = await import("../src/index.js");
    const { currentToolCallId } = await import("../src/als.js");
    withPome();

    let idAtEntry: string | null = null;

    const t = tool(
      "parallel_fanout",
      "Issues parallel fetches after chained awaits.",
      FAKE_SCHEMA,
      async () => {
        idAtEntry = currentToolCallId();
        await new Promise((r) => setTimeout(r, 0));
        await Promise.all([
          (async () => {
            await new Promise((r) => setTimeout(r, 0));
            await globalThis.fetch("http://127.0.0.1:3333/v1/a");
          })(),
          (async () => {
            await new Promise((r) => setTimeout(r, 0));
            await globalThis.fetch("http://127.0.0.1:3333/v1/b");
          })(),
        ]);
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    await (t as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> }).handler(
      {},
      {},
    );

    expect(idAtEntry).toMatch(/^tlc_/);
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.headers["x-pome-correlation-id"]).toBe(idAtEntry);
    }
  });
});
