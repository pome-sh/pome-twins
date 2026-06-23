import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredentials, writeCredentialsFile } from "../../src/cli/credentials.js";
import { HostedAuthError } from "../../src/hosted/errors.js";

async function writeTestCredFile(path: string, body: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(body), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeTestCredRaw(path: string, raw: string): Promise<void> {
  await writeFile(path, raw, { mode: 0o600 });
  await chmod(path, 0o600);
}

describe("resolveCredentials", () => {
  const savedKey = process.env.POME_API_KEY;
  const savedUrl = process.env.POME_API_URL;

  beforeEach(() => {
    delete process.env.POME_API_KEY;
    delete process.env.POME_API_URL;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.POME_API_KEY;
    else process.env.POME_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.POME_API_URL;
    else process.env.POME_API_URL = savedUrl;
  });

  it("returns the env var when set, ignoring the file", async () => {
    process.env.POME_API_KEY = "pme_from_env";
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: "pme_from_file",
      });
      const out = await resolveCredentials({
        apiBaseUrl: "https://api.example.com",
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiKey).toBe("pme_from_env");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the file when env is unset", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: "pme_from_file",
      });
      const out = await resolveCredentials({
        apiBaseUrl: "https://api.example.com",
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiKey).toBe("pme_from_file");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("uses api_url from credentials written by pome login when caller passes none", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: "pme_from_file",
        api_url: "https://api.from-login.example.com",
      });
      // Caller passes no apiBaseUrl — stored api_url wins.
      const out = await resolveCredentials({
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiBaseUrl).toBe("https://api.from-login.example.com");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // F0-6 regression — caller's apiBaseUrl (CLI flag / env, resolved by main.ts)
  // must win over a stored Keychain/file api_url. Before this fix, the
  // `process.env.POME_API_URL ?? stored ?? input` ladder inside
  // resolveCredentials let a stale Keychain api_url shadow the explicit
  // `--api-url` flag whenever POME_API_URL env was unset, silently routing
  // requests at the prod control plane.
  it("caller-provided apiBaseUrl wins over stored api_url (F0-6)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: "pme_from_file",
        api_url: "https://api.pome.sh",
      });
      const out = await resolveCredentials({
        apiBaseUrl: "http://127.0.0.1:9999",
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiBaseUrl).toBe("http://127.0.0.1:9999");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws HostedAuthError when both are missing (F0-5c)", async () => {
    // F0-5c — `pome logout && pome run` was returning exit 2 ("twin/orch")
    // because credential-resolution threw a plain Error. Now it throws
    // `HostedAuthError`, which `exitCodeFor` maps to the documented exit 3.
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await expect(
        resolveCredentials({
          apiBaseUrl: "https://api.example.com",
          credentialsPath: join(tmp, "credentials.json"),
        })
      ).rejects.toBeInstanceOf(HostedAuthError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // After F0-6, POME_API_URL no longer overrides inside resolveCredentials —
  // env folding happens in `cli/main.ts`'s Commander option default, so the
  // env-resolved value reaches us as `input.apiBaseUrl`. This test mirrors
  // that contract: caller's input wins.
  it("caller-provided apiBaseUrl wins over POME_API_URL env", async () => {
    process.env.POME_API_KEY = "pme_x";
    process.env.POME_API_URL = "https://staging.example.com";
    const out = await resolveCredentials({
      apiBaseUrl: "https://api.example.com",
      credentialsPath: "/dev/null",
    });
    expect(out.apiBaseUrl).toBe("https://api.example.com");
  });

  it("normalizes trailing slashes from caller's apiBaseUrl", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: " pme_from_file ",
        api_url: "https://api.from-login.example.com/",
      });
      const out = await resolveCredentials({
        apiBaseUrl: "https://api.example.com/",
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiKey).toBe("pme_from_file");
      // Caller wins; stored api_url is ignored when caller passes one.
      expect(out.apiBaseUrl).toBe("https://api.example.com");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes trailing slashes from stored api_url when caller passes none", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {
        api_key: " pme_from_file ",
        api_url: "https://api.from-login.example.com/",
      });
      const out = await resolveCredentials({
        credentialsPath: join(tmp, "credentials.json"),
      });
      expect(out.apiKey).toBe("pme_from_file");
      expect(out.apiBaseUrl).toBe("https://api.from-login.example.com");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("trims whitespace from env-set keys", async () => {
    process.env.POME_API_KEY = "  pme_padded  ";
    const out = await resolveCredentials({
      apiBaseUrl: "https://api.example.com",
      credentialsPath: "/dev/null",
    });
    expect(out.apiKey).toBe("pme_padded");
  });

  it("throws when the credentials file is not valid JSON", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredRaw(join(tmp, "credentials.json"), "not json {");
      await expect(
        resolveCredentials({
          apiBaseUrl: "https://api.example.com",
          credentialsPath: join(tmp, "credentials.json"),
        })
      ).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws when the credentials file is missing api_key", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    try {
      await writeTestCredFile(join(tmp, "credentials.json"), {});
      await expect(
        resolveCredentials({
          apiBaseUrl: "https://api.example.com",
          credentialsPath: join(tmp, "credentials.json"),
        })
      ).rejects.toThrow(/missing "api_key"/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes credentials with owner-only permissions", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-cred-"));
    const path = join(tmp, "credentials.json");
    try {
      await writeFile(path, JSON.stringify({ api_key: "old" }), { mode: 0o644 });
      await writeCredentialsFile(
        {
          api_key: "pme_secret",
          api_url: "https://api.example.com",
          dashboard_url: "https://app.example.com",
          team_id: "tm_test",
        },
        path
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
