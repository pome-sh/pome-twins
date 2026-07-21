import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SLUG_RE } from "@pome-sh/shared-types";

import {
  MANIFEST_JSON,
  MANIFEST_YAML,
  findManifestPath,
  readManifest,
  readRequiredManifest,
  writeManifest,
} from "../../src/cli/project-config.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("manifest loader", () => {
  it("walks up from a nested dir to find pome.json and parses the agent block", async () => {
    const projectDir = await makeProject();
    const nested = join(projectDir, "tasks", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(projectDir, MANIFEST_JSON),
      JSON.stringify({
        agent: { slug: "pr-review-agent", name: "PR Review Agent", version: "0.2.0", framework: "langgraph" },
        command: "npm start",
        twins: ["github"],
      }),
    );

    const found = await findManifestPath(nested);
    expect(found).toEqual({ path: join(projectDir, MANIFEST_JSON), format: "json" });

    const read = await readManifest(nested);
    expect(read?.path).toBe(join(projectDir, MANIFEST_JSON));
    expect(read?.format).toBe("json");
    expect(read?.manifest.agent.slug).toBe("pr-review-agent");
    expect(read?.manifest.agent.version).toBe("0.2.0");
    expect(read?.manifest.agent.framework).toBe("langgraph");
    expect(read?.manifest.command).toBe("npm start");
    expect(read?.manifest.twins).toEqual(["github"]);
    // run-config defaults injected by the schema
    expect(read?.manifest.artifacts_dir).toBe("runs");
    expect(read?.manifest.pass_threshold).toBe(100);
  });

  it("reads a pome.yaml carrier with identical keys", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, MANIFEST_YAML),
      [
        "agent:",
        "  slug: pr-review-agent",
        "  name: PR Review Agent",
        "  version: 0.2.0",
        "command: npm start",
        "twins: [github]",
      ].join("\n"),
    );

    const found = await findManifestPath(projectDir);
    expect(found).toEqual({ path: join(projectDir, MANIFEST_YAML), format: "yaml" });
    const read = await readManifest(projectDir);
    expect(read?.manifest.agent.slug).toBe("pr-review-agent");
    expect(read?.manifest.agent.version).toBe("0.2.0");
    expect(read?.manifest.command).toBe("npm start");
  });

  it("hard-errors when both pome.json and pome.yaml are present in the same dir, naming both", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, MANIFEST_JSON),
      JSON.stringify({ agent: { slug: "a" } }),
    );
    await writeFile(join(projectDir, MANIFEST_YAML), "agent:\n  slug: a\n");

    await expect(findManifestPath(projectDir)).rejects.toThrow(/pome\.json.*pome\.yaml|pome\.yaml.*pome\.json/s);
  });

  it("invalid slug error shows SLUG_RE and a suggestion slugified from agent.name", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, MANIFEST_JSON),
      JSON.stringify({ agent: { slug: "Not A Slug!", name: "PR Review Agent" } }),
    );

    const err = await readManifest(projectDir).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(String(SLUG_RE));
    expect(err!.message).toContain("pr-review-agent");
  });

  it("missing slug with a name still suggests a slugification of the name", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, MANIFEST_JSON),
      JSON.stringify({ agent: { name: "Triage Bot" } }),
    );
    await expect(readManifest(projectDir)).rejects.toThrow(/triage-bot/);
  });

  it("returns null when no manifest exists; readRequired throws pointing at pome init", async () => {
    const projectDir = await makeProject();
    expect(await findManifestPath(projectDir)).toBeNull();
    expect(await readManifest(projectDir)).toBeNull();
    await expect(readRequiredManifest(projectDir)).rejects.toThrow(/pome init/);
  });

  it("writeManifest (json) round-trips through the loader and pretty-prints with a trailing newline", async () => {
    const projectDir = await makeProject();
    const path = join(projectDir, MANIFEST_JSON);
    await writeManifest(path, "json", {
      $schema: "https://pome.sh/schemas/v1/pome.json",
      agent: { slug: "my-agent" },
      command: "node a.js",
    });
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "agent": {');
    const read = await readManifest(projectDir);
    expect(read?.manifest.agent.slug).toBe("my-agent");
    expect(read?.manifest.command).toBe("node a.js");
  });
});
