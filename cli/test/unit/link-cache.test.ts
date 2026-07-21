import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePomeGitignored,
  readLinkCache,
  resolveCachedAgentId,
  writeLinkCache,
} from "../../src/cli/link-cache.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-link-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("link cache", () => {
  it("writes .pome/link.json with agent_id, team_id and an ISO resolved_at, and reads it back", async () => {
    const dir = await makeProject();
    await writeLinkCache(dir, { agent_id: "agt_abc", team_id: "tm_xyz" });

    const onDisk = JSON.parse(await readFile(join(dir, ".pome", "link.json"), "utf8"));
    expect(onDisk.agent_id).toBe("agt_abc");
    expect(onDisk.team_id).toBe("tm_xyz");
    expect(() => new Date(onDisk.resolved_at).toISOString()).not.toThrow();
    expect(Number.isNaN(Date.parse(onDisk.resolved_at))).toBe(false);

    const cache = await readLinkCache(dir);
    expect(cache).toMatchObject({ agent_id: "agt_abc", team_id: "tm_xyz" });
  });

  it("readLinkCache returns null when absent or malformed", async () => {
    const dir = await makeProject();
    expect(await readLinkCache(dir)).toBeNull();

    await mkdir(join(dir, ".pome"), { recursive: true });
    await writeFile(join(dir, ".pome", "link.json"), "{not json");
    expect(await readLinkCache(dir)).toBeNull();

    await writeFile(join(dir, ".pome", "link.json"), JSON.stringify({ agent_id: 123 }));
    expect(await readLinkCache(dir)).toBeNull();
  });

  it("resolveCachedAgentId short-circuits only when team_id matches the caller's team", async () => {
    const cache = { agent_id: "agt_abc", team_id: "tm_a", resolved_at: "2026-07-19T00:00:00Z" };
    expect(resolveCachedAgentId(cache, "tm_a")).toBe("agt_abc");
    // Foreign team: never surface the cached (foreign) id.
    expect(resolveCachedAgentId(cache, "tm_b")).toBeUndefined();
    expect(resolveCachedAgentId(cache, undefined)).toBeUndefined();
    expect(resolveCachedAgentId(null, "tm_a")).toBeUndefined();
  });

  it("ensurePomeGitignored creates .gitignore when absent", async () => {
    const dir = await makeProject();
    await ensurePomeGitignored(dir);
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text.split(/\r?\n/)).toContain(".pome/");
  });

  it("appends .pome/ to an existing .gitignore that lacks it, and is idempotent", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, ".gitignore"), "node_modules\nruns\n");
    await ensurePomeGitignored(dir);
    let text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text.split(/\r?\n/)).toContain(".pome/");
    expect(text).toContain("node_modules");

    await ensurePomeGitignored(dir);
    text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text.split(/\r?\n/).filter((l) => l === ".pome/")).toHaveLength(1);
  });

  it("treats a bare .pome entry as already ignored (no duplicate)", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, ".gitignore"), ".pome\n");
    await ensurePomeGitignored(dir);
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text.split(/\r?\n/).filter((l) => l === ".pome/")).toHaveLength(0);
  });
});
