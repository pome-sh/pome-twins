/**
 * Shared pome-cloud plumbing for minimal-viktor's trial orchestrator.
 *
 * One credential path and one fetch helper for everything that talks to the
 * pome control plane or a twin sandbox outside `pome run`:
 *   - createSlackSession / deleteSession  (raw POST /v1/sessions — the CLI's
 *     `pome session create` caps twins to github|stripe, so the slack sandbox
 *     has to be minted against the raw API)
 *   - fetchSlackState                     (GET <twin_url>/_pome/state)
 *
 * Credentials resolve exactly like the pome CLI (cli/src/cli/credentials.ts):
 *   POME_API_KEY env → macOS keychain `sh.pome.cli`/`hosted` → ~/.pome/credentials.json
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PomeCredentials {
  apiKey: string;
  apiUrl: string;
  dashboardUrl: string;
}

export interface SlackSandbox {
  sessionId: string;
  twinUrl: string;
  agentToken: string;
}

/** Seed shared by every scenario: one channel, the bot user, one human. */
export const SLACK_SEED = {
  team: { id: "T_VIKTORHQ", name: "Viktor HQ", domain: "viktor-hq" },
  users: [
    { id: "U_AGENT", name: "pome-agent", real_name: "Viktor Bot" },
    { id: "U_GAGAN", name: "gagan", real_name: "Gagan Devagiri" },
  ],
  channels: [{ id: "C_ALERTS", name: "eng-alerts", members: ["U_AGENT", "U_GAGAN"] }],
};

export async function resolveCredentials(): Promise<PomeCredentials> {
  const envKey = process.env.POME_API_KEY?.trim();
  if (envKey) {
    return {
      apiKey: envKey,
      apiUrl: process.env.POME_API_URL?.trim() || "https://api.pome.sh",
      dashboardUrl: "https://app.pome.sh",
    };
  }
  const fromKeychain = await readKeychain();
  if (fromKeychain) return fromKeychain;
  const fromFile = await readCredentialsFile();
  if (fromFile) return fromFile;
  throw new Error("No pome credentials found. Run `pome login` or set POME_API_KEY.");
}

async function readKeychain(): Promise<PomeCredentials | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "sh.pome.cli",
      "-a",
      "hosted",
      "-w",
    ]);
    return parseCredentialsJson(stdout);
  } catch {
    return null;
  }
}

async function readCredentialsFile(): Promise<PomeCredentials | null> {
  try {
    const raw = await readFile(join(homedir(), ".pome", "credentials.json"), "utf8");
    return parseCredentialsJson(raw);
  } catch {
    return null;
  }
}

function parseCredentialsJson(raw: string): PomeCredentials | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    const apiKey = typeof parsed.api_key === "string" ? parsed.api_key : null;
    if (!apiKey) return null;
    return {
      apiKey,
      apiUrl: typeof parsed.api_url === "string" ? parsed.api_url : "https://api.pome.sh",
      dashboardUrl:
        typeof parsed.dashboard_url === "string" ? parsed.dashboard_url : "https://app.pome.sh",
    };
  } catch {
    return null;
  }
}

/**
 * Mint a fresh hosted slack twin sandbox. Flat seed first (FDRS-365 rejected
 * the wrapped `{slack:{seed}}` envelope for scenario files and the cloud
 * matches); retry wrapped on a 4xx just in case the contracts diverge.
 */
export async function createSlackSession(creds: PomeCredentials): Promise<SlackSandbox> {
  const scenarioSource = Buffer.from("minimal-viktor slack sandbox", "utf8").toString("base64");
  const attempt = (seed: unknown) =>
    controlPlane(creds, "POST", "/v1/sessions", {
      twins: ["slack"],
      seed,
      scenario_source: scenarioSource,
    });

  let res = await attempt(SLACK_SEED);
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 402 && res.status !== 429) {
    res = await attempt({ slack: { seed: SLACK_SEED } });
  }
  if (res.status === 401) {
    throw new Error("pome cloud rejected the API key (401). Run `pome login` or set POME_API_KEY.");
  }
  if (res.status === 402 || res.status === 429) {
    throw new Error(`pome cloud quota/rate limit (${res.status}): ${res.text}`);
  }
  if (res.status >= 400) {
    throw new Error(`pome cloud rejected a slack sandbox (${res.status}): ${res.text}`);
  }
  const body = JSON.parse(res.text) as {
    session_id: string;
    twin_url: string | null;
    agent_token: string;
    per_twin?: Record<string, { api_url: string }>;
  };
  const twinUrl = body.per_twin?.slack?.api_url ?? body.twin_url;
  if (!twinUrl) throw new Error("create session response had no slack twin URL");
  return { sessionId: body.session_id, twinUrl: twinUrl.replace(/\/$/, ""), agentToken: body.agent_token };
}

export async function deleteSession(creds: PomeCredentials, sessionId: string): Promise<void> {
  const res = await controlPlane(creds, "DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  if (res.status >= 400 && res.status !== 404) {
    console.warn(`[run-trials] DELETE ${sessionId} -> ${res.status} (sandbox may be leaked): ${res.text}`);
  }
}

export interface SlackMessage {
  text: string;
  user_id: string;
  ts: string;
}

/** Export the sandbox's state and flatten the target channel's messages. */
export async function fetchSlackMessages(
  sandbox: SlackSandbox,
  channelName: string,
): Promise<SlackMessage[]> {
  const res = await fetch(`${sandbox.twinUrl}/_pome/state`, {
    headers: { authorization: `Bearer ${sandbox.agentToken}` },
  });
  if (!res.ok) {
    throw new Error(`slack /_pome/state -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const state = (await res.json()) as {
    channels?: Array<{ name: string; messages?: Array<{ text: string; user_id: string; ts: string }> }>;
  };
  const channel = state.channels?.find((c) => c.name === channelName);
  return (channel?.messages ?? []).map((m) => ({ text: m.text, user_id: m.user_id, ts: m.ts }));
}

/** Post a message directly (used by --probe, not by the agent). */
export async function postSlackMessage(
  sandbox: SlackSandbox,
  channel: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${sandbox.twinUrl}/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sandbox.agentToken}` },
    body: JSON.stringify({ channel, text }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || body?.ok === false) {
    throw new Error(`chat.postMessage failed (${res.status}): ${body?.error ?? "unknown"}`);
  }
}

async function controlPlane(
  creds: PomeCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${creds.apiUrl}${path}`, {
    method,
    headers: {
      "x-api-key": creds.apiKey,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}
