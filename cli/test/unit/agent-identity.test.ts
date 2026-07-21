import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRunAgentIdentity } from "../../src/cli/agent-identity.js";
import { writeLinkCache } from "../../src/cli/link-cache.js";

const tempDirs: string[] = [];
const savedKey = process.env.POME_API_KEY;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function makeProject(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-identity-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "pome.json"), JSON.stringify(manifest));
  return dir;
}

async function writeCreds(dir: string, teamId: string): Promise<string> {
  const path = join(dir, "creds.json");
  await writeFile(
    path,
    JSON.stringify({ api_key: "pme_test", api_url: "https://api.example.com", dashboard_url: "https://app", team_id: teamId }),
  );
  await chmod(path, 0o600);
  return path;
}

beforeEach(() => {
  delete process.env.POME_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.POME_API_KEY;
  else process.env.POME_API_KEY = savedKey;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolveRunAgentIdentity", () => {
  it("returns {} with only the version override when no manifest is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-identity-empty-"));
    tempDirs.push(dir);
    const id = await resolveRunAgentIdentity({ startDir: dir, apiBaseUrl: "https://api.example.com" });
    expect(id).toEqual({});

    const withOverride = await resolveRunAgentIdentity({
      startDir: dir,
      apiBaseUrl: "https://api.example.com",
      agentVersionOverride: "9.9.9",
    });
    expect(withOverride).toEqual({ agentVersion: "9.9.9" });
  });

  it("short-circuits to the cached agent_id when the team matches (no network)", async () => {
    const dir = await makeProject({ agent: { slug: "pr-review-agent", version: "0.2.0", framework: "langgraph" } });
    const credentialsPath = await writeCreds(dir, "tm_team");
    await writeLinkCache(dir, { agent_id: "agt_cached", team_id: "tm_team" });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const id = await resolveRunAgentIdentity({ startDir: dir, apiBaseUrl: "https://api.example.com", credentialsPath });

    expect(id).toMatchObject({ agentId: "agt_cached", agentVersion: "0.2.0", framework: "langgraph" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-resolves by slug (silently) when the cached team differs, and refreshes the cache", async () => {
    const dir = await makeProject({ agent: { slug: "pr-review-agent" } });
    const credentialsPath = await writeCreds(dir, "tm_new");
    // Cache belongs to a FOREIGN team — must never be surfaced.
    await writeLinkCache(dir, { agent_id: "agt_foreign", team_id: "tm_old" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ id: "agt_fresh", slug: "pr-review-agent", display_name: "PR", judge_model: "m" }));

    const id = await resolveRunAgentIdentity({ startDir: dir, apiBaseUrl: "https://api.example.com", credentialsPath });

    expect(id.agentId).toBe("agt_fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.slug).toBe("pr-review-agent");
    // Cache refreshed under the caller's team.
    expect(JSON.parse(readFileSync(join(dir, ".pome", "link.json"), "utf8"))).toMatchObject({
      agent_id: "agt_fresh",
      team_id: "tm_new",
    });
  });

  it("the version override wins over the manifest agent.version", async () => {
    const dir = await makeProject({ agent: { slug: "pr-review-agent", version: "0.2.0" } });
    const credentialsPath = await writeCreds(dir, "tm_team");
    await writeLinkCache(dir, { agent_id: "agt_cached", team_id: "tm_team" });

    const id = await resolveRunAgentIdentity({
      startDir: dir,
      apiBaseUrl: "https://api.example.com",
      credentialsPath,
      agentVersionOverride: "1.2.3",
    });
    expect(id.agentVersion).toBe("1.2.3");
  });

  it("degrades to unattributed (no throw) when resolution fails", async () => {
    const dir = await makeProject({ agent: { slug: "pr-review-agent", version: "0.2.0" } });
    const credentialsPath = await writeCreds(dir, "tm_team");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ error: { type: "internal_error", message: "boom", request_id: "r" } }, 500));

    const id = await resolveRunAgentIdentity({ startDir: dir, apiBaseUrl: "https://api.example.com", credentialsPath });
    // No cache, resolution 500s → agentId undefined, but version still flows.
    expect(id.agentId).toBeUndefined();
    expect(id.agentVersion).toBe("0.2.0");
  });
});
