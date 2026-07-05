// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { nanoid, newGroupId } from "../../../src/demo/ids.js";

// Mirror of pome-cloud lib/demo.ts isValidGroupId.
const CLOUD_GROUP_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

describe("demo trial-group ids (FDRS-643)", () => {
  it("mints grp_ + 21 url-safe chars", () => {
    const id = newGroupId();
    expect(id).toMatch(/^grp_[\w-]{21}$/);
  });

  it("is accepted by the cloud's group_id format gate", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newGroupId()).toMatch(CLOUD_GROUP_ID_RE);
    }
  });

  it("does not collide across invocations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) seen.add(newGroupId());
    expect(seen.size).toBe(1_000);
  });

  it("nanoid honors the size parameter", () => {
    expect(nanoid(10)).toHaveLength(10);
    expect(nanoid()).toHaveLength(21);
  });
});
