import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedOrchError } from "../../src/hosted/errors.js";
import { ensureAgentRegistered, runRegisterAgent } from "../../src/cli/register.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const savedKey = process.env.POME_API_KEY;
const savedUrl = process.env.POME_API_URL;

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

async function writeConfig(body: unknown) {
  await writeFile("pome.config.json", `${JSON.stringify(body, null, 2)}\n`);
}

function readConfig() {
  return JSON.parse(readFileSync("pome.config.json", "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pome-register-"));
  tempDirs.push(projectDir);
  process.chdir(projectDir);
  process.env.POME_API_KEY = "pme_test";
  delete process.env.POME_API_URL;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (savedKey === undefined) delete process.env.POME_API_KEY;
  else process.env.POME_API_KEY = savedKey;
  if (savedUrl === undefined) delete process.env.POME_API_URL;
  else process.env.POME_API_URL = savedUrl;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runRegisterAgent", () => {
  it("posts to the caller-supplied apiBaseUrl (F0-6 precedence: caller wins)", async () => {
    await writeConfig({ agent: { command: "node agent.js" } });
    // POME_API_URL is intentionally set to a *different* URL than the caller
    // passes. Per F0-6, env folding happens in `cli/main.ts`'s Commander
    // option default before reaching the runner, so by the time we land in
    // `resolveCredentials`, the caller-supplied value is the canonical
    // resolved override. Re-checking env here would shadow an explicit
    // `--api-url` flag — see `credentials.ts` precedence doc-comment.
    process.env.POME_API_URL = "https://env-should-not-win.example.com/";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        response({
          id: "agt_123",
          slug: "triage-bot",
          display_name: "Triage Bot",
          judge_model: "google/gemini-2.5-flash",
        }),
      );

    await runRegisterAgent({
      apiBaseUrl: "https://input.example.com",
      name: "Triage Bot",
      force: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://input.example.com/v1/agents",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "pme_test" }),
      }),
    );
  });

  it("fails clearly when pome.config.json is missing", async () => {
    await expect(
      runRegisterAgent({
        apiBaseUrl: "https://api.example.com",
        name: "Triage Bot",
        force: false,
      }),
    ).rejects.toThrow(/pome\.config\.json not found/);
  });

  it("is idempotent when agentId already exists without --force", async () => {
    await writeConfig({ agentId: "agt_existing", agent: { command: "node a.js" } });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bot",
      force: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readConfig().agentId).toBe("agt_existing");
  });

  it("force overwrites agent fields while preserving unrelated keys", async () => {
    await writeConfig({
      agentId: "agt_old",
      artifactsDir: "runs",
      agent: { command: "node a.js" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        id: "agt_new",
        slug: "new-agent",
        display_name: "New\nAgent",
        judge_model: "google/gemini-2.5-flash",
      }),
    );

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "New Agent",
      force: true,
    });

    expect(readConfig()).toMatchObject({
      agentId: "agt_new",
      agentSlug: "new-agent",
      artifactsDir: "runs",
      agent: { command: "node a.js" },
    });
  });

  it("rejects unexpected response shapes", async () => {
    await writeConfig({ agent: { command: "node a.js" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ id: "agt_only" }));

    await expect(
      runRegisterAgent({
        apiBaseUrl: "https://api.example.com",
        name: "Bad Shape",
        force: false,
      }),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("explains /v1/agents 404 as route/version skew", async () => {
    await writeConfig({ agent: { command: "node a.js" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, { status: 404 }));

    await expect(
      runRegisterAgent({
        apiBaseUrl: "https://api.example.com",
        name: "Triage Bot",
        force: false,
      }),
    ).rejects.toThrow(/not available|version/);
  });

  it("rejects malformed agentId instead of treating it as idempotent", async () => {
    await writeConfig({ agentId: "   " });
    await expect(
      runRegisterAgent({
        apiBaseUrl: "https://api.example.com",
        name: "Triage Bot",
        force: false,
      }),
    ).rejects.toThrow(/malformed agentId/);
    expect(existsSync("pome.config.json")).toBe(true);
  });
});

// FDRS-669 — the `pome install` registration seam: same machinery as
// `pome register agent`, but derives the name from the repo directory and
// never errors on an already-registered repo (idempotent by design).
describe("ensureAgentRegistered (FDRS-669)", () => {
  it("registers a fresh repo under the config directory's name and writes agentId + agentSlug", async () => {
    await writeConfig({ agent: { command: "node a.js" } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        id: "agt_123",
        slug: "my-repo",
        display_name: "my-repo",
        judge_model: "google/gemini-2.5-flash",
      }),
    );

    const result = await ensureAgentRegistered({
      apiBaseUrl: "https://api.example.com",
    });

    expect(result).toEqual({
      status: "registered",
      agentId: "agt_123",
      agentSlug: "my-repo",
    });
    // The server-side name is the repo directory's basename (vercel-link
    // shape: identity defaults to where you ran it).
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/agents");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      name: basename(process.cwd()),
    });
    expect(readConfig()).toMatchObject({
      agentId: "agt_123",
      agentSlug: "my-repo",
      agent: { command: "node a.js" },
    });
  });

  it("is idempotent: an already-registered repo makes no request and keeps the same slug", async () => {
    await writeConfig({
      agentId: "agt_existing",
      agentSlug: "existing-agent",
      agent: { command: "node a.js" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const first = await ensureAgentRegistered({
      apiBaseUrl: "https://api.example.com",
    });
    const second = await ensureAgentRegistered({
      apiBaseUrl: "https://api.example.com",
    });

    expect(first).toEqual({
      status: "already-registered",
      agentId: "agt_existing",
      agentSlug: "existing-agent",
    });
    expect(second).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readConfig()).toMatchObject({
      agentId: "agt_existing",
      agentSlug: "existing-agent",
    });
  });

  it("returns no-config without fetching when pome.config.json is absent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await ensureAgentRegistered({
      apiBaseUrl: "https://api.example.com",
    });

    expect(result).toEqual({ status: "no-config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
