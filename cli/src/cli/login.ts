// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { persistCredentialsAfterLogin } from "./credentials.js";

export interface LoginOptions {
  apiUrl: string;
  dashboardUrl: string;
  keyName: string;
}

interface ExchangeResponse {
  api_key?: {
    full_key?: string;
    id?: string;
  };
  team_id?: string;
}

export async function loginWithClerk(options: LoginOptions): Promise<void> {
  const state = randomBytes(16).toString("base64url");
  const callback = await startCallbackServer(state);

  const loginUrl = new URL("/cli/login", normalizeBaseUrl(options.dashboardUrl));
  loginUrl.searchParams.set("redirect_uri", callback.redirectUri);
  loginUrl.searchParams.set("state", state);

  console.error("Opening Clerk sign-in in your browser…");
  console.error(String(loginUrl));
  await openBrowser(String(loginUrl));

  let codeResult: { code: string };
  try {
    codeResult = await callback.waitForCode();
  } finally {
    await callback.close();
  }

  const exchanged = await exchangeCode({
    apiUrl: normalizeBaseUrl(options.apiUrl),
    code: codeResult.code,
    keyName: options.keyName,
  });

  if (!exchanged.api_key?.full_key || !exchanged.team_id) {
    throw new Error("CLI login exchange returned an unexpected response.");
  }

  const { stored, path } = await persistCredentialsAfterLogin({
    api_key: exchanged.api_key.full_key,
    api_url: normalizeBaseUrl(options.apiUrl),
    dashboard_url: normalizeBaseUrl(options.dashboardUrl),
    team_id: exchanged.team_id,
  });

  if (stored === "keychain") {
    console.error("Saved Pome credentials in macOS Keychain.");
  } else if (path) {
    console.error(`Saved Pome credentials to ${path}`);
  }

  console.error(
    `Team: ${exchanged.team_id} · API key id: ${exchanged.api_key.id ?? "(created)"}`,
  );
  console.error("Next: `pome session create --twin github` or `pome run <scenario>.md`");
}

async function exchangeCode(input: {
  apiUrl: string;
  code: string;
  keyName: string;
}): Promise<ExchangeResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch(
      `${normalizeBaseUrl(input.apiUrl)}/v1/auth/cli/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: input.code, key_name: input.keyName }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        "CLI login exchange timed out (60s). Check network and API URL, then run `pome login` again.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let json: unknown = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) {
      throw new Error(`CLI login exchange failed: HTTP ${response.status}`);
    }
    throw new Error("CLI login exchange returned invalid JSON.");
  }
  if (!response.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ??
      `HTTP ${response.status}`;
    throw new Error(
      `CLI login exchange failed: ${message}. Run \`pome login\` again for a fresh code.`,
    );
  }
  return json as ExchangeResponse;
}

interface CallbackServer {
  redirectUri: string;
  waitForCode(): Promise<{ code: string }>;
  close(): Promise<void>;
}

async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  let server: Server | null = null;
  let resolveCode: ((value: { code: string }) => void) | null = null;
  let rejectCode: ((reason?: unknown) => void) | null = null;
  let settled = false;
  let deliveredCode = false;

  const codePromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    rejectCode?.(err);
  };

  const succeed = (code: string) => {
    if (deliveredCode) return;
    deliveredCode = true;
    if (settled) return;
    settled = true;
    resolveCode?.({ code });
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error && state === expectedState) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Pome login failed</h1><p>You can close this tab.</p>");
      fail(new Error(`Browser reported error: ${error}`));
      void closeServer(server);
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Invalid login callback</h1><p>State did not match — close this tab and run <code>pome login</code> again.</p>",
      );
      return;
    }

    if (deliveredCode) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Already complete</h1><p>You can close this tab.</p>");
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>Pome login complete</h1><p>You can close this tab.</p>");
    succeed(code);
    void closeServer(server);
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local login callback server.");
  }

  const timeout = setTimeout(() => {
    fail(
      new Error(
        "Timed out waiting for browser login (5 min). Run `pome login` again.",
      ),
    );
    void closeServer(server);
  }, 5 * 60 * 1000);
  timeout.unref();

  const onInt = () => {
    fail(new Error("Login cancelled (Ctrl+C). No credentials were changed."));
    void closeServer(server);
  };
  process.once("SIGINT", onInt);

  codePromise.finally(() => {
    clearTimeout(timeout);
    process.off("SIGINT", onInt);
  });

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode() {
      return codePromise;
    },
    async close() {
      clearTimeout(timeout);
      process.off("SIGINT", onInt);
      await closeServer(server);
    },
  };
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => {
    server?.close(() => resolve());
  });
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "powershell.exe"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-Command", "Start-Process", url]
      : [url];

  await new Promise<void>((resolve) => {
    execFile(command, args, (error) => {
      if (error) {
        console.error(
          "Could not open a browser automatically — copy the URL above into a browser.",
        );
      }
      resolve();
    });
  });
}

function normalizeBaseUrl(raw: string): string {
  return new URL(raw).toString().replace(/\/$/, "");
}
