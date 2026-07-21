// SPDX-License-Identifier: Apache-2.0
//
// F-818 — the canonical pome.json / pome.yaml manifest data model. The manifest
// zod schema, SLUG_RE, and deriveAgentSlug live here as the single source of
// truth consumed by CLI, control-plane, and MCP; the control-plane's private
// copies (apps/control-plane/src/routes/agents.ts SLUG_RE and
// packages/db/src/agent-slug.ts deriveAgentSlug in pome-cloud) are retired in
// favor of these exports (F-820), so local and server validation stay
// byte-identical. Full format spec: Linear F-804.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  SLUG_RE,
  deriveAgentSlug,
  manifestAgentSchema,
  manifestSchema,
} from "../src/index.js";

// The F-804 canonical pome.json example, verbatim.
const POME_JSON_EXAMPLE = `{
  "$schema": "https://pome.sh/schemas/v1/pome.json",
  "agent": {
    "slug": "pr-review-agent",
    "name": "PR Review Agent",
    "description": "Reviews PRs against team conventions",
    "version": "0.2.0",
    "framework": "langgraph"
  },
  "command": "npm start",
  "twins": ["github"],
  "tasks": "tasks/",
  "artifacts_dir": "runs",
  "pass_threshold": 100
}`;

// The F-804 pome.yaml alias, verbatim — same keys, different carrier.
const POME_YAML_EXAMPLE = `# yaml-language-server: $schema=https://pome.sh/schemas/v1/pome.json
agent:
  slug: pr-review-agent
  name: PR Review Agent
  description: Reviews PRs against team conventions
  version: 0.2.0
  framework: langgraph
command: npm start
twins: [github]
tasks: tasks/
artifacts_dir: runs
pass_threshold: 100
`;

describe("SLUG_RE (F-818)", () => {
  it("is byte-identical to the control-plane's slug regex", () => {
    // The whole point of the move: local and server validation share one
    // regex. This pins the source so a 'harmless' edit here is loud.
    expect(SLUG_RE.source).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(SLUG_RE.flags).toBe("");
  });

  it("accepts kebab slugs and rejects everything else", () => {
    for (const good of ["a", "pr-review-agent", "a1-b2", "0agent"]) {
      expect(SLUG_RE.test(good), good).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a b", "émile"]) {
      expect(SLUG_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("deriveAgentSlug (F-818)", () => {
  it("derives the canonical kebab slug from a display name", () => {
    expect(deriveAgentSlug("PR Review Agent")).toBe("pr-review-agent");
  });

  it("trims, collapses separator runs, and strips edge dashes", () => {
    expect(deriveAgentSlug("  My --- Agent!  ")).toBe("my-agent");
    expect(deriveAgentSlug("Émile's Agent")).toBe("mile-s-agent");
  });

  it("returns the empty string when nothing sluggable remains", () => {
    expect(deriveAgentSlug("")).toBe("");
    expect(deriveAgentSlug("---")).toBe("");
    expect(deriveAgentSlug("!!!")).toBe("");
  });

  it("passes SLUG_RE for any non-empty derivation", () => {
    for (const input of ["PR Review Agent", "a", "9 Lives", "x_y.z"]) {
      const slug = deriveAgentSlug(input);
      expect(slug === "" || SLUG_RE.test(slug), input).toBe(true);
    }
  });

  it("is behavior-identical to the pome-cloud reference implementation", () => {
    // The upstream packages/db/src/agent-slug.ts body, verbatim. Our export
    // rewrites the edge-strip to linear regexes (CodeQL js/polynomial-redos);
    // this corpus pins that the observable mapping never diverged.
    const reference = (input: string): string =>
      input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    const corpus = [
      "PR Review Agent",
      "  My --- Agent!  ",
      "Émile's Agent",
      "---",
      "--a--b--",
      "-a-",
      "!!!",
      "",
      "a",
      "9 Lives",
      "x_y.z",
      `${"-".repeat(500)}a${"-".repeat(500)}`,
      "UPPER_case  mixed\t123",
    ];
    for (const input of corpus) {
      expect(deriveAgentSlug(input), JSON.stringify(input)).toBe(reference(input));
    }
  });
});

describe("manifestSchema — carrier-agnostic (F-818)", () => {
  it("validates the F-804 pome.json example verbatim", () => {
    const parsed = manifestSchema.parse(JSON.parse(POME_JSON_EXAMPLE));
    expect(parsed.agent.slug).toBe("pr-review-agent");
    expect(parsed.agent.framework).toBe("langgraph");
    expect(parsed.command).toBe("npm start");
    expect(parsed.twins).toEqual(["github"]);
    expect(parsed.tasks).toBe("tasks/");
  });

  it("validates the F-804 pome.yaml example and yields the same manifest", () => {
    const fromYaml = manifestSchema.parse(parseYaml(POME_YAML_EXAMPLE));
    const fromJson = manifestSchema.parse(JSON.parse(POME_JSON_EXAMPLE));
    // Carriers share keys: apart from the JSON-only "$schema" pointer the two
    // parses are the same manifest.
    const { $schema: _ignored, ...jsonRest } = fromJson;
    expect(fromYaml).toEqual(jsonRest);
  });

  it("requires only agent.slug — a minimal manifest parses", () => {
    const parsed = manifestSchema.parse({ agent: { slug: "my-agent" } });
    expect(parsed.agent.slug).toBe("my-agent");
  });

  it("applies the documented CLI run-config defaults (runs / 100)", () => {
    const parsed = manifestSchema.parse({ agent: { slug: "my-agent" } });
    expect(parsed.artifacts_dir).toBe("runs");
    expect(parsed.pass_threshold).toBe(100);
  });

  it("rejects a manifest without an agent block", () => {
    expect(manifestSchema.safeParse({ command: "npm start" }).success).toBe(false);
  });

  it("rejects invalid slugs (case, separators, length > 64)", () => {
    for (const slug of ["My-Agent", "a_b", "-lead", "trail-", "a".repeat(65)]) {
      expect(manifestSchema.safeParse({ agent: { slug } }).success, slug).toBe(false);
    }
    expect(manifestSchema.safeParse({ agent: { slug: "a".repeat(64) } }).success).toBe(true);
  });

  it("rejects an out-of-range pass_threshold", () => {
    for (const pass_threshold of [-1, 101, 99.5]) {
      expect(
        manifestSchema.safeParse({ agent: { slug: "a" }, pass_threshold }).success,
        String(pass_threshold),
      ).toBe(false);
    }
  });

  it("accepts unknown framework values (open enum — warn, never block)", () => {
    const parsed = manifestAgentSchema.parse({ slug: "a", framework: "my-bespoke-framework" });
    expect(parsed.framework).toBe("my-bespoke-framework");
  });
});
