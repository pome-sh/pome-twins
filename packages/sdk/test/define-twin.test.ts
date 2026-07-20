// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin, TwinManifestError } from "../src/index.js";

describe("defineTwin", () => {
  it("accepts a minimal valid manifest", () => {
    const def = defineTwin({
      id: "minimal",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    expect(def.id).toBe("minimal");
    expect(def.tools).toHaveLength(0);
  });

  it("accepts a manifest with seed schema, routes, tools, admin", () => {
    const seed = z.object({ items: z.array(z.string()) });
    const def = defineTwin({
      id: "with-everything",
      version: "1.2.3",
      fidelity: { default: "shape" },
      seed,
      domain: ({ seed }) => ({ items: seed?.items ?? [] }),
      routes: () => {},
      admin: { reset: () => undefined, seed: () => undefined },
      state: () => ({}),
      tools: [
        {
          name: "do_thing",
          description: "Does a thing.",
          schema: z.object({}),
          handler: () => ({ ok: true }),
          mutation: true,
        },
      ],
    });
    expect(def.tools).toHaveLength(1);
    expect(def.tools[0]?.mutation).toBe(true);
  });

  it("accepts optional title/outputSchema and recordingProjection", () => {
    const def = defineTwin({
      id: "optional-mcp",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      recordingProjection: (event) => event,
      tools: [
        {
          name: "listed",
          description: "Has MCP metadata.",
          title: "Listed",
          schema: z.object({}),
          handler: () => ({ ok: true }),
          mutation: false,
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    expect(def.tools[0]?.title).toBe("Listed");
    expect(def.tools[0]?.outputSchema).toEqual({ type: "object" });
    expect(typeof def.recordingProjection).toBe("function");
  });

  it("rejects invalid id (non-slug)", () => {
    expect(() =>
      defineTwin({
        id: "Has Spaces",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [],
      })
    ).toThrow(TwinManifestError);
  });

  it("rejects empty version", () => {
    expect(() =>
      defineTwin({
        id: "ok",
        version: "",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [],
      })
    ).toThrow(TwinManifestError);
  });

  it("rejects unknown fidelity tier", () => {
    expect(() =>
      defineTwin({
        id: "ok",
        version: "0.0.1",
        // @ts-expect-error — invalid tier
        fidelity: { default: "perfect" },
        domain: () => ({}),
        tools: [],
      })
    ).toThrow(TwinManifestError);
  });

  it("rejects tool with non-Zod schema", () => {
    expect(() =>
      defineTwin({
        id: "ok",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [
          {
            name: "bad_tool",
            description: "x",
            // @ts-expect-error — not a Zod schema
            schema: { parse: () => ({}) },
            handler: () => ({}),
            mutation: false,
          },
        ],
      })
    ).toThrow(TwinManifestError);
  });

  it("rejects tool with non-boolean mutation flag", () => {
    expect(() =>
      defineTwin({
        id: "ok",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [
          {
            name: "bad_tool",
            description: "x",
            schema: z.object({}),
            handler: () => ({}),
            mutation: "sometimes" as unknown as boolean,
          },
        ],
      })
    ).toThrow(TwinManifestError);
  });

  it("rejects duplicate tool names", () => {
    expect(() =>
      defineTwin({
        id: "ok",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [
          {
            name: "dup",
            description: "first",
            schema: z.object({}),
            handler: () => ({}),
            mutation: false,
          },
          {
            name: "dup",
            description: "second",
            schema: z.object({}),
            handler: () => ({}),
            mutation: false,
          },
        ],
      })
    ).toThrow(/Duplicate tool name/);
  });

  it("attaches issues array to TwinManifestError on shape violations", () => {
    try {
      defineTwin({
        id: "",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        tools: [],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TwinManifestError);
      expect((err as TwinManifestError).issues.length).toBeGreaterThan(0);
    }
  });
});
