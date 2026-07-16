// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseScenarioFile } from "../../src/scenario/parseScenario.js";

const SCENARIO_MARKDOWN = `# Test scenario

## Prompt

Triage issue #1.

## Success Criteria

- [code] Stub criterion

## Seed State

(prose here would be compiled to JSON — but for the sidecar branch the prose is ignored)

## Config

\`\`\`yaml
twins: [github]
passThreshold: 100
\`\`\`
`;

const SIDECAR_SEED = {
  _meta: {
    version: 1,
    source_hash: "sha256:test",
    model: "claude-opus-4-7",
    compiled_at: "2026-05-22T00:00:00.000Z"
  },
  repositories: [
    {
      owner: "acme",
      name: "api",
      labels: [{ name: "bug" }],
      collaborators: ["alice"],
      issues: [{ number: 1, title: "test", body: "test", labels: [], assignee: null }]
    }
  ]
};

describe("parseScenarioFile sidecar handling", () => {
  it("loads seed from .seed.json sidecar when present, ignoring prose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-sidecar-"));
    const mdPath = join(dir, "scenario.md");
    const sidecarPath = join(dir, "scenario.seed.json");
    await writeFile(mdPath, SCENARIO_MARKDOWN);
    await writeFile(sidecarPath, JSON.stringify(SIDECAR_SEED));

    const scenario = await parseScenarioFile(mdPath);

    expect(scenario.seedState).toBeDefined();
    const ghSeed = scenario.seedState as { repositories: Array<{ owner: string; name: string }> };
    expect(Array.isArray(ghSeed.repositories)).toBe(true);
    expect(ghSeed.repositories[0]!.owner).toBe("acme");
    expect(ghSeed.repositories[0]!.name).toBe("api");
    // _meta should have been stripped by stripSidecarMeta before schema parse
    expect((scenario.seedState as Record<string, unknown>)._meta).toBeUndefined();
  });

  it("falls back to inline JSON when no sidecar exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-inline-"));
    const mdPath = join(dir, "scenario.md");
    const mdWithInline = SCENARIO_MARKDOWN.replace(
      "(prose here would be compiled to JSON — but for the sidecar branch the prose is ignored)",
      '```json\n{\n  "repositories": [{ "owner": "legacy", "name": "repo", "issues": [{ "number": 1, "title": "from-inline", "labels": [] }] }]\n}\n```'
    );
    await writeFile(mdPath, mdWithInline);

    const scenario = await parseScenarioFile(mdPath);
    const ghSeed = scenario.seedState as { repositories: Array<{ owner: string }> };
    expect(ghSeed.repositories[0]!.owner).toBe("legacy");
  });

  it("throws a clear error when sidecar is not valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-bad-sidecar-"));
    const mdPath = join(dir, "scenario.md");
    const sidecarPath = join(dir, "scenario.seed.json");
    await writeFile(mdPath, SCENARIO_MARKDOWN);
    await writeFile(sidecarPath, "{ not json");

    await expect(parseScenarioFile(mdPath)).rejects.toThrow(/Sidecar seed.*not valid JSON/);
  });
});
