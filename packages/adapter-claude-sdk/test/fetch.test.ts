// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callContext } from "../src/als.js";
import {
  CORRELATION_HEADER,
  installFetchHook,
  uninstallFetchHook,
} from "../src/fetch.js";

let originalFetch: typeof globalThis.fetch;
let captured: Array<{ url: string; headers: Record<string, string> }>;

beforeEach(() => {
  captured = [];
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
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k.toLowerCase()] = v;
    } else if (h) {
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = (h as Record<string, string>)[k]!;
    }
    captured.push({ url, headers });
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  uninstallFetchHook();
  globalThis.fetch = originalFetch;
});

describe("installFetchHook", () => {
  it("replaces globalThis.fetch", () => {
    const before = globalThis.fetch;
    installFetchHook({ twinHosts: [] });
    expect(globalThis.fetch).not.toBe(before);
  });

  it("uninstallFetchHook restores the prior fetch", () => {
    const before = globalThis.fetch;
    installFetchHook({ twinHosts: [] });
    uninstallFetchHook();
    expect(globalThis.fetch).toBe(before);
  });

  it("a second install is idempotent (wraps once)", () => {
    installFetchHook({ twinHosts: [] });
    const first = globalThis.fetch;
    installFetchHook({ twinHosts: [] });
    expect(globalThis.fetch).toBe(first);
  });

  it("injects x-pome-correlation-id header for allowlisted host inside tool callContext", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await callContext.run({ tool_call_id: "tlc_abc" }, async () => {
      await globalThis.fetch("http://127.0.0.1:3333/v1/repos");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_abc");
  });

  it("does NOT inject header for non-allowlisted host (e.g. anthropic.com)", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await callContext.run({ tool_call_id: "tlc_abc" }, async () => {
      await globalThis.fetch("https://api.anthropic.com/v1/messages");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });

  it("does NOT inject header outside any tool callContext", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await globalThis.fetch("http://127.0.0.1:3333/v1/repos");
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });

  it("matches the allowlist by URL origin (not exact path)", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await callContext.run({ tool_call_id: "tlc_x" }, async () => {
      await globalThis.fetch("http://127.0.0.1:3333/anything/deep/path?q=1");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_x");
  });

  it("preserves user-set headers when injecting", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await callContext.run({ tool_call_id: "tlc_x" }, async () => {
      await globalThis.fetch("http://127.0.0.1:3333/foo", {
        method: "POST",
        headers: { authorization: "Bearer abc", "content-type": "application/json" },
        body: JSON.stringify({ x: 1 }),
      });
    });
    expect(captured[0]!.headers["authorization"]).toBe("Bearer abc");
    expect(captured[0]!.headers["content-type"]).toBe("application/json");
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_x");
  });

  it("supports URL object input", async () => {
    installFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await callContext.run({ tool_call_id: "tlc_url" }, async () => {
      await globalThis.fetch(new URL("http://127.0.0.1:3333/v1/anything"));
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_url");
  });

  it("empty allowlist injects nothing even if inside callContext", async () => {
    installFetchHook({ twinHosts: [] });
    await callContext.run({ tool_call_id: "tlc_x" }, async () => {
      await globalThis.fetch("http://127.0.0.1:3333/foo");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });
});
