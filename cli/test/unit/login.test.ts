import { get } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginWithClerk } from "../../src/cli/login.js";

type BrowserOpenHandler = (url: string) => void;

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, args: string[], callback) => {
    const url = args.at(-1);
    if (url) browserOpenHandler?.(url);
    callback?.(null);
  }),
}));

let browserOpenHandler: BrowserOpenHandler | undefined;

describe("loginWithClerk", () => {
  const savedHome = process.env.HOME;
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    browserOpenHandler = undefined;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    globalThis.fetch = savedFetch;
    browserOpenHandler = undefined;
  });

  it("ignores invalid local callbacks while waiting for the real Clerk callback", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pome-login-"));
    process.env.HOME = tmp;

    const exchange = vi.fn(async () =>
      new Response(
        JSON.stringify({
          api_key: {
            id: "pme_created",
            full_key: "pme_created_secret",
          },
          team_id: "tm_login",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    globalThis.fetch = exchange as typeof fetch;

    browserOpenHandler = (url) => {
      const loginUrl = new URL(url);
      const redirectUri = loginUrl.searchParams.get("redirect_uri");
      const state = loginUrl.searchParams.get("state");
      expect(redirectUri).toBeTruthy();
      expect(state).toBeTruthy();

      queueMicrotask(async () => {
        await requestLocal(`${redirectUri}?code=wrong&state=wrong`);
        await requestLocal(`${redirectUri}?code=valid_code&state=${state}`);
      });
    };

    try {
      await loginWithClerk({
        apiUrl: "https://api.example.com/",
        dashboardUrl: "https://dashboard.example.com/",
        keyName: "test key",
      });

      expect(exchange).toHaveBeenCalledWith(
        "https://api.example.com/v1/auth/cli/exchange",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: "valid_code", key_name: "test key" }),
        })
      );

      const credentials = JSON.parse(
        await readFile(join(tmp, ".pome", "credentials.json"), "utf8")
      );
      expect(credentials).toMatchObject({
        api_key: "pme_created_secret",
        api_url: "https://api.example.com",
        dashboard_url: "https://dashboard.example.com",
        team_id: "tm_login",
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

async function requestLocal(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}
