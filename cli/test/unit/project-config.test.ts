import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findProjectConfigPath,
  normalizeConfigAgentCommand,
  normalizeConfigAgentId,
  normalizeConfigAgentSdk,
  readProjectConfig,
} from "../../src/cli/project-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("project config helpers", () => {
  it("walks up from a scenario directory to find pome.config.json", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-config-"));
    tempDirs.push(projectDir);
    const scenarioDir = join(projectDir, "scenarios", "nested");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(scenarioDir, { recursive: true }),
    );
    await writeFile(
      join(projectDir, "pome.config.json"),
      JSON.stringify({
        agentId: "agt_registered",
        agent: {
          sdk: " claude-agent-sdk ",
          command: " node custom-agent.js ",
        },
      }),
    );

    const path = await findProjectConfigPath(scenarioDir);
    expect(path).toBe(join(projectDir, "pome.config.json"));
    const read = await readProjectConfig(scenarioDir);
    expect(read?.path).toBe(path);
    expect(normalizeConfigAgentId(read!.config)).toBe("agt_registered");
    expect(normalizeConfigAgentSdk(read!.config)).toBe("claude-agent-sdk");
    expect(normalizeConfigAgentCommand(read!.config)).toBe("node custom-agent.js");
  });

  it("rejects malformed registered agent ids instead of silently dropping them", () => {
    expect(() => normalizeConfigAgentId({ agentId: "bad-id" })).toThrow(
      /agt_/,
    );
  });
});
