// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the meta.json version-resolution logic (D18.1 / F-689).
// specMeta.ts resolves each twin's INSTALLED package version by requiring the
// bare specifier and walking up to the manifest whose `name` matches. These
// tests mock `node:module` + `node:fs` so the resolvable / unresolvable /
// multi-twin / cache branches are exercised deterministically, without
// depending on which twin packages happen to be installed in this checkout.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: vi.fn() };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  META_SPEC_VERSION,
  resolveTwinPackageVersions,
  resetTwinVersionCacheForTests,
} from "../../../src/recorder/specMeta.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockCreateRequire = vi.mocked(createRequire);

// A fake `require` whose `.resolve` maps a bare specifier to an entry file, or
// throws (unresolvable) — mirrors node's module resolution for our purposes.
function fakeRequire(resolver: (id: string) => string): NodeRequire {
  return { resolve: resolver } as unknown as NodeRequire;
}

// Installed manifests keyed by the twin id embedded in the resolved path.
const INSTALLED: Record<string, string> = {
  github: "9.9.9",
  stripe: "2.0.0",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetTwinVersionCacheForTests();

  // resolve() returns a plausible node_modules entry file for known ids and
  // throws MODULE_NOT_FOUND-style for everything else.
  mockCreateRequire.mockReturnValue(
    fakeRequire((id) => {
      const match = id.match(/^@pome-sh\/twin-(.+)$/);
      const twinId = match?.[1];
      if (twinId && twinId in INSTALLED) {
        return `/np/node_modules/@pome-sh/twin-${twinId}/dist/index.js`;
      }
      throw new Error(`Cannot find module '${id}'`);
    }),
  );
  // The package root's package.json is the first walk-up candidate for our
  // fake entry path, so a single existsSync=true short-circuits the loop.
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation(((p: unknown) => {
    const s = String(p);
    const match = s.match(/@pome-sh\/twin-([^/]+)/);
    const twinId = match?.[1];
    if (twinId && twinId in INSTALLED) {
      return JSON.stringify({
        name: `@pome-sh/twin-${twinId}`,
        version: INSTALLED[twinId],
      });
    }
    throw new Error(`unexpected readFileSync: ${s}`);
  }) as typeof readFileSync);
});

describe("META_SPEC_VERSION", () => {
  it("is a positive integer (bump on a breaking meta.json shape change)", () => {
    expect(Number.isInteger(META_SPEC_VERSION)).toBe(true);
    expect(META_SPEC_VERSION).toBeGreaterThan(0);
  });
});

describe("resolveTwinPackageVersions", () => {
  it("returns {} for an empty twin list", () => {
    expect(resolveTwinPackageVersions([])).toEqual({});
  });

  it("OMITS an unresolvable twin id (never fabricates a version)", () => {
    expect(resolveTwinPackageVersions(["not-a-real-twin"])).toEqual({});
  });

  it("resolves a single installed twin to its manifest version", () => {
    expect(resolveTwinPackageVersions(["github"])).toEqual({ github: "9.9.9" });
  });

  it("multi-twin: includes every resolvable twin and omits the unresolvable ones", () => {
    expect(
      resolveTwinPackageVersions(["github", "stripe", "ghost-twin"]),
    ).toEqual({ github: "9.9.9", stripe: "2.0.0" });
  });

  it("caches a resolved version — a second lookup does not re-read the manifest", () => {
    expect(resolveTwinPackageVersions(["github"])).toEqual({ github: "9.9.9" });
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    // Second call is served from cache: no additional filesystem read.
    expect(resolveTwinPackageVersions(["github"])).toEqual({ github: "9.9.9" });
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("caches the OMITTED (unresolvable) result too — no repeated resolution attempts", () => {
    expect(resolveTwinPackageVersions(["ghost-twin"])).toEqual({});
    const callsAfterFirst = mockCreateRequire.mock.calls.length;
    expect(resolveTwinPackageVersions(["ghost-twin"])).toEqual({});
    // Cache hit: createRequire is not invoked again for the same id.
    expect(mockCreateRequire.mock.calls.length).toBe(callsAfterFirst);
  });

  it("resetTwinVersionCacheForTests() forces re-resolution on the next lookup", () => {
    resolveTwinPackageVersions(["github"]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    resetTwinVersionCacheForTests();
    resolveTwinPackageVersions(["github"]);
    // Cache cleared → the manifest is read a second time.
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });
});
