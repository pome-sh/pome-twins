import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedOrchError } from "../../src/hosted/errors.js";
import {
  ensureAgentRegistered,
  normalizeRegisterTwins,
  runRegisterAgent,
} from "../../src/cli/register.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const savedKey = process.env.POME_API_KEY;
const savedUrl = process.env.POME_API_URL;
const savedCi = process.env.CI;

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const AGENT_OK = {
  id: "agt_123",
  slug: "triage-bot",
  display_name: "Triage Bot",
  judge_model: "google/gemini-2.5-flash",
};

async function writeManifest(body: unknown) {
  await writeFile("pome.json", `${JSON.stringify(body, null, 2)}\n`);
}

function readManifestFile() {
  return JSON.parse(readFileSync("pome.json", "utf8")) as Record<string, unknown>;
}

function readLink() {
  return JSON.parse(readFileSync(join(".pome", "link.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Write a 0600 credentials file so resolveCredentials surfaces a team_id
 *  (the env-key path has no team, so link.json can't be team-gated there). */
async function writeCreds(dir: string, teamId: string): Promise<string> {
  const path = join(dir, "creds.json");
  await writeFile(
    path,
    JSON.stringify({
      api_key: "pme_test",
      api_url: "https://api.example.com",
      dashboard_url: "https://app.example.com",
      team_id: teamId,
    }),
  );
  await chmod(path, 0o600);
  return path;
}

beforeEach(async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pome-register-"));
  tempDirs.push(projectDir);
  process.chdir(projectDir);
  process.env.POME_API_KEY = "pme_test";
  delete process.env.POME_API_URL;
  delete process.env.CI;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (savedKey === undefined) delete process.env.POME_API_KEY;
  else process.env.POME_API_KEY = savedKey;
  if (savedUrl === undefined) delete process.env.POME_API_URL;
  else process.env.POME_API_URL = savedUrl;
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runRegisterAgent", () => {
  it("posts name + manifest identity to the caller-supplied apiBaseUrl and writes pome.json from the response", async () => {
    await writeManifest({ agent: { slug: "old-slug", version: "0.2.0", framework: "langgraph" }, command: "node a.js" });
    process.env.POME_API_URL = "https://env-should-not-win.example.com/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(AGENT_OK));

    await runRegisterAgent({
      apiBaseUrl: "https://input.example.com",
      name: "Triage Bot",
      force: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://input.example.com/v1/agents");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ name: "Triage Bot", version: "0.2.0", framework: "langgraph" });
    // Manifest now carries the server-canonical slug (no agt_ id in the file).
    const manifest = readManifestFile();
    expect(manifest).toMatchObject({
      agent: { slug: "triage-bot", name: "Triage Bot" },
      command: "node a.js",
    });
    expect("agentId" in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("agt_");
  });

  it("writes .pome/link.json (team-gated) and appends .pome/ to .gitignore", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "triage-bot" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(AGENT_OK));

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bot",
      force: false,
      credentialsPath,
    });

    expect(readLink()).toMatchObject({ agent_id: "agt_123", team_id: "tm_team" });
    expect(readFileSync(".gitignore", "utf8").split(/\r?\n/)).toContain(".pome/");
  });

  it("fails clearly when no manifest is present", async () => {
    await expect(
      runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bot", force: false }),
    ).rejects.toThrow(/pome init/);
  });

  it("short-circuits (no network) when link.json already resolves under the caller's team", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "triage-bot" } });
    // Pre-seed a matching link cache.
    const { writeLinkCache } = await import("../../src/cli/link-cache.js");
    await writeLinkCache(dir, { agent_id: "agt_existing", team_id: "tm_team" });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bot",
      force: false,
      credentialsPath,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--force re-resolves even when a matching link cache exists", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "triage-bot" } });
    const { writeLinkCache } = await import("../../src/cli/link-cache.js");
    await writeLinkCache(dir, { agent_id: "agt_existing", team_id: "tm_team" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(AGENT_OK));

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bot",
      force: true,
      credentialsPath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readLink().agent_id).toBe("agt_123");
  });

  it("warns (not blocks) on an unknown framework via did-you-mean", async () => {
    await writeManifest({ agent: { slug: "triage-bot", framework: "langraph" } });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errors.push(String(m)));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(AGENT_OK));

    await runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bot", force: false });

    expect(errors.join("\n")).toMatch(/langraph/);
    expect(errors.join("\n")).toMatch(/langgraph/);
  });

  it("rejects an unexpected response shape via the shared zod schema", async () => {
    await writeManifest({ agent: { slug: "triage-bot" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ id: "agt_only" }));

    await expect(
      runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Bad", force: false }),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("explains /v1/agents 404 as route/version skew", async () => {
    await writeManifest({ agent: { slug: "triage-bot" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, { status: 404 }));

    await expect(
      runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bot", force: false }),
    ).rejects.toThrow(/not available|version/);
  });

  it("POSTs {name, twins} and prints the cloud's enabled services", async () => {
    await writeManifest({ agent: { slug: "triage-bot" } });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errors.push(String(m)));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ ...AGENT_OK, enabled_services: ["github", "slack"] }));

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bot",
      force: false,
      twins: ["github", "slack"],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ name: "Triage Bot", twins: ["github", "slack"] });
    expect(errors.join("\n")).toContain("Enabled services: github, slack");
  });
});

describe("runRegisterAgent near-miss", () => {
  const conflict = () =>
    response(
      { error: { type: "conflict", message: "near-miss", details: { suggestion: "triage-bot" }, request_id: "req_1" } },
      { status: 409 },
    );

  it("non-TTY / CI: warns and proceeds to create with confirm:true", async () => {
    process.env.CI = "1";
    await writeManifest({ agent: { slug: "triage-bott" } });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errors.push(String(m)));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(response(AGENT_OK));

    await runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bott", force: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(retry.confirm).toBe(true);
    expect(errors.join("\n")).toMatch(/triage-bot/);
  });

  it("interactive YES: re-resolves the suggested existing slug", async () => {
    await writeManifest({ agent: { slug: "triage-bott" } });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(response(AGENT_OK));

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bott",
      force: false,
      stdinIsTTY: true,
      confirm: async () => true,
    });

    const retry = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(retry.slug).toBe("triage-bot");
    expect(retry.confirm).toBeUndefined();
  });

  it("interactive NO: creates the typed slug with confirm:true", async () => {
    await writeManifest({ agent: { slug: "triage-bott" } });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(response(AGENT_OK));

    await runRegisterAgent({
      apiBaseUrl: "https://api.example.com",
      name: "Triage Bott",
      force: false,
      stdinIsTTY: true,
      confirm: async () => false,
    });

    const retry = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(retry.confirm).toBe(true);
  });
});

describe("slug-rename hint (F-861)", () => {
  const RENAMED = {
    ...AGENT_OK,
    slug: "pr-review-agent",
    display_name: "PR Review Agent",
    resolved_via: "alias" as const,
    hint: 'Resolved "pr-reviewer" via a slug alias; the canonical slug is now "pr-review-agent".',
  };

  function spyErrors(): string[] {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errors.push(String(m)));
    return errors;
  }

  it("register: on an alias resolve to a new slug, prints the rename notice, names the new slug, confirms pome.json, and surfaces the hint", async () => {
    await writeManifest({ agent: { slug: "pr-reviewer" }, command: "node a.js" });
    const errors = spyErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(RENAMED));

    await runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "PR Review Agent", force: false });

    const out = errors.join("\n");
    expect(out).toContain("pr-reviewer"); // old slug named
    expect(out).toContain("pr-review-agent"); // new slug named
    expect(out).toMatch(/renamed/i);
    expect(out).toContain("pome.json"); // confirms the manifest was updated
    expect(out).toContain("canonical slug is now"); // server hint surfaced verbatim
    // Attribution self-heal: the manifest now carries the new slug.
    expect(readManifestFile()).toMatchObject({ agent: { slug: "pr-review-agent" } });
  });

  it("install: the shared createAndPersistAgent prints the same rename notice", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "pr-reviewer" } });
    const errors = spyErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(RENAMED));

    await ensureAgentRegistered({ apiBaseUrl: "https://api.example.com", credentialsPath });

    const out = errors.join("\n");
    expect(out).toMatch(/renamed/i);
    expect(out).toContain("pr-review-agent");
    expect(readManifestFile()).toMatchObject({ agent: { slug: "pr-review-agent" } });
  });

  it("no notice on a normal live-slug resolve (resolved_via: slug, unchanged slug)", async () => {
    await writeManifest({ agent: { slug: "triage-bot" } });
    const errors = spyErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ ...AGENT_OK, resolved_via: "slug" }),
    );

    await runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bot", force: false });

    expect(errors.join("\n")).not.toMatch(/renamed/i);
  });

  it("no notice on a fresh create, even when the derived slug differs from the manifest", async () => {
    await writeManifest({ agent: { slug: "old-slug" } });
    const errors = spyErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ ...AGENT_OK, slug: "triage-bot", resolved_via: "created", created: true }),
    );

    await runRegisterAgent({ apiBaseUrl: "https://api.example.com", name: "Triage Bot", force: false });

    expect(errors.join("\n")).not.toMatch(/renamed/i);
  });
});

describe("normalizeRegisterTwins", () => {
  it("parses and de-dupes a comma list", () => {
    expect(normalizeRegisterTwins("github, slack ,github")).toEqual(["github", "slack"]);
  });
  it("returns undefined for absent / empty input", () => {
    expect(normalizeRegisterTwins(undefined)).toBeUndefined();
    expect(normalizeRegisterTwins("  , ")).toBeUndefined();
  });
  it("rejects an unknown twin against MOUNTED_TWINS", () => {
    expect(() => normalizeRegisterTwins("github,notion")).toThrow(/Unknown twin/);
  });
});

describe("ensureAgentRegistered", () => {
  it("registers a fresh repo, writing the manifest slug + link.json under the caller's team", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "old" }, command: "node a.js" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ ...AGENT_OK, slug: "my-repo", display_name: "my-repo" }));

    const result = await ensureAgentRegistered({ apiBaseUrl: "https://api.example.com", credentialsPath });

    expect(result).toEqual({ status: "registered", agentId: "agt_123", agentSlug: "my-repo" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readManifestFile()).toMatchObject({ agent: { slug: "my-repo" }, command: "node a.js" });
    expect(readLink()).toMatchObject({ agent_id: "agt_123", team_id: "tm_team" });
    expect(basename(dir)).toBeTruthy();
  });

  it("is idempotent: a repo already linked under the caller's team makes no request", async () => {
    const dir = process.cwd();
    const credentialsPath = await writeCreds(dir, "tm_team");
    delete process.env.POME_API_KEY;
    await writeManifest({ agent: { slug: "existing-agent" } });
    const { writeLinkCache } = await import("../../src/cli/link-cache.js");
    await writeLinkCache(dir, { agent_id: "agt_existing", team_id: "tm_team" });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await ensureAgentRegistered({ apiBaseUrl: "https://api.example.com", credentialsPath });

    expect(result).toEqual({
      status: "already-registered",
      agentId: "agt_existing",
      agentSlug: "existing-agent",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no-config without fetching when no manifest is present", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await ensureAgentRegistered({ apiBaseUrl: "https://api.example.com" });
    expect(result).toEqual({ status: "no-config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
