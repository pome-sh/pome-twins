// SPDX-License-Identifier: Apache-2.0
//
// F-818 — snapshot guard for the zod-generated manifest JSON Schema. The
// committed manifest-schema.json is what pome.sh/schemas/v1/pome.json serves
// (F-821) and what editors resolve via the manifest's `$schema` pointer; this
// test pins its bytes to `buildManifestJsonSchema()` so the emitted output
// stays stable across builds — any zod upgrade or schema edit that changes the
// generated document must re-emit the file in the same PR
// (`npm run emit:manifest-schema`).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLUG_RE, buildManifestJsonSchema } from "../src/index.js";

const COMMITTED_PATH = new URL("../manifest-schema.json", import.meta.url);

describe("manifest JSON Schema emission (F-818)", () => {
  it("matches the committed manifest-schema.json byte-for-byte", () => {
    const committed = readFileSync(COMMITTED_PATH, "utf8");
    expect(committed).toBe(`${JSON.stringify(buildManifestJsonSchema(), null, 2)}\n`);
  });

  it("is deterministic across calls", () => {
    expect(buildManifestJsonSchema()).toEqual(buildManifestJsonSchema());
  });

  it("carries the served $id and requires only the agent block", () => {
    const schema = buildManifestJsonSchema() as {
      $id: string;
      required: string[];
      properties: { agent: { required: string[]; properties: { slug: { pattern: string } } } };
    };
    expect(schema.$id).toBe("https://pome.sh/schemas/v1/pome.json");
    // Author-side (input) shape: run-config keys with defaults stay optional.
    expect(schema.required).toEqual(["agent"]);
    expect(schema.properties.agent.required).toEqual(["slug"]);
    // The one regex, everywhere — the emitted pattern is SLUG_RE itself.
    expect(schema.properties.agent.properties.slug.pattern).toBe(SLUG_RE.source);
  });
});
