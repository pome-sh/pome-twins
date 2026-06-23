// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallFetchHook } from "../src/fetch.js";
import { _resetInitForTest, getInstalledTwinHosts, withPome } from "../src/init.js";

const ENV_KEYS = [
  "POME_TWIN_BASE_URL",
  "POME_GITHUB_MCP_URL",
  "POME_STRIPE_BASE_URL",
] as const;

const saved: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  uninstallFetchHook();
  _resetInitForTest();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("withPome", () => {
  it("replaces globalThis.fetch on first call", () => {
    const before = globalThis.fetch;
    withPome();
    expect(globalThis.fetch).not.toBe(before);
  });

  it("is idempotent — second call does not double-wrap", () => {
    withPome();
    const after1 = globalThis.fetch;
    withPome();
    expect(globalThis.fetch).toBe(after1);
  });

  it("with no env and no opts: installed twinHosts is empty", () => {
    withPome();
    expect(getInstalledTwinHosts()).toEqual([]);
  });

  it("infers twinHosts from POME_TWIN_BASE_URL", () => {
    process.env.POME_TWIN_BASE_URL = "http://127.0.0.1:3333";
    withPome();
    expect(getInstalledTwinHosts()).toContain("http://127.0.0.1:3333");
  });

  it("infers twinHosts from POME_GITHUB_MCP_URL (normalizes to origin)", () => {
    process.env.POME_GITHUB_MCP_URL = "http://127.0.0.1:3333/s/demo/mcp";
    withPome();
    expect(getInstalledTwinHosts()).toContain("http://127.0.0.1:3333");
  });

  it("merges multiple POME_* env sources, deduped", () => {
    process.env.POME_TWIN_BASE_URL = "http://127.0.0.1:3333";
    process.env.POME_GITHUB_MCP_URL = "http://127.0.0.1:3333/s/demo/mcp";
    process.env.POME_STRIPE_BASE_URL = "http://127.0.0.1:4444";
    withPome();
    const hosts = getInstalledTwinHosts();
    expect(new Set(hosts)).toEqual(new Set(["http://127.0.0.1:3333", "http://127.0.0.1:4444"]));
  });

  it("explicit { twinHosts } overrides env inference", () => {
    process.env.POME_TWIN_BASE_URL = "http://127.0.0.1:3333";
    withPome({ twinHosts: ["http://example.test:9999"] });
    expect(getInstalledTwinHosts()).toEqual(["http://example.test:9999"]);
  });

  it("silently skips malformed env URLs", () => {
    process.env.POME_TWIN_BASE_URL = "not-a-url";
    process.env.POME_GITHUB_MCP_URL = "http://127.0.0.1:3333";
    withPome();
    expect(getInstalledTwinHosts()).toEqual(["http://127.0.0.1:3333"]);
  });
});
