import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  findTwin,
  runnableScenarios,
} from "../../src/cli/scenarios-catalog.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pome init", () => {
  it("scaffolds starter scenarios and agents without overwriting config", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "init"]);

    const githubTwin = findTwin("github");
    expect(githubTwin).not.toBeNull();
    expect(existsSync("pome.json")).toBe(true);
    // The manifest is valid: it carries a slug derived from the project dir.
    expect(JSON.parse(readFileSync("pome.json", "utf8")).agent.slug).toMatch(/^[a-z0-9-]+$/);
    for (const scenario of runnableScenarios(githubTwin!)) {
      expect(existsSync(join("scenarios", scenario.filename))).toBe(true);
    }
    expect(existsSync("scenarios/14-stripe-refund-retry.md")).toBe(false);
    expect(existsSync("scenarios/20-slack-exfiltration.md")).toBe(false);
    expect(existsSync("examples/agents/scripted-triage-agent.ts")).toBe(true);

    // Bundled .seed.json sidecars must land alongside their .md so that
    // `pome run scenarios/01-...` doesn't fall into the prose-seed parse path.
    expect(existsSync("scenarios/01-bug-happy-path.seed.json")).toBe(true);
    // 04-judge-context now ships a sidecar that pre-labels issue #1 `bug`
    // (the default seed leaves it unlabeled). Init must copy it alongside the .md.
    expect(existsSync("scenarios/04-judge-context.md")).toBe(true);
    expect(existsSync("scenarios/04-judge-context.seed.json")).toBe(true);

    await createProgram().parseAsync(["node", "pome", "init"]);

    expect(readFileSync("pome.json", "utf8")).toContain("scripted-triage-agent.ts");
    const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("pome register agent <name>");

    // Bundled example agents must not use top-level await. `npx tsx <file>` in
    // a project without `"type": "module"` falls back to CJS, and top-level
    // await fails the CJS transform — every scripted run would die before its
    // first tool call.
    const agentFiles = readdirSync("examples/agents").filter((f) =>
      f.endsWith(".ts"),
    );
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const f of agentFiles) {
      const src = readFileSync(join("examples/agents", f), "utf8");
      // Match `await` at column 0 (a likely top-level await) outside of a
      // function body. Anything inside `async function main()` will be
      // indented.
      const offending = src
        .split("\n")
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => /^await\b/.test(line));
      expect(
        offending,
        `${f} contains top-level await on lines: ${offending
          .map((o) => o.idx + 1)
          .join(", ")}`,
      ).toEqual([]);
    }
  });
});
