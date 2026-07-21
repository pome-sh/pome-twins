// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HostedAuthError } from "../hosted/errors.js";
import {
  deleteKeychainCredentials,
  keychainSupported,
  readKeychainCredentials,
  writeKeychainCredentials,
} from "./keychain.js";

// CLI auth resolution policy. Single source of truth for "where does the
// hosted-mode API key come from?" —
//
// Precedence (api key):
//   1. POME_API_KEY env var (CI / one-off / `direnv`)
//   2. macOS Keychain item (when available and populated)
//   3. ~/.pome/credentials.json (persistent; chmod 600)
//
// Precedence (api base URL):
//   1. `input.apiBaseUrl` — caller's resolved value, which by convention
//      already folds in the `--api-url` flag and the POME_API_URL env var
//      via Commander's option default in `cli/main.ts`. Flag > env. Don't
//      re-check env here — that would shadow the explicit flag value
//      (F0-6 regression where a stored Keychain `api_url` won over the
//      flag because env was unset, so the keychain branch took the
//      stored value).
//   2. Stored `api_url` on the Keychain/file credentials record, used
//      only when the caller passes no override.
//   3. Default control-plane URL (fallback).

export interface ResolveCredentialsInput {
  /** Optional. If set, wins over any stored `api_url`. Callers should pass
   *  the resolved `--api-url` flag value (which Commander defaults to the
   *  POME_API_URL env var or `DEFAULT_CONTROL_PLANE_URL`). Leave undefined
   *  to fall back to the stored value. */
  apiBaseUrl?: string;
  credentialsPath?: string;
}

export interface ResolvedCredentials {
  apiKey: string;
  apiBaseUrl: string;
  /** The team the api key belongs to, when known (stored at login). Powers the
   *  `.pome/link.json` team gate (F-819). Undefined for a bare `POME_API_KEY`
   *  env key, whose team is known only server-side. */
  teamId?: string;
}

export interface CredentialsFile {
  api_key?: string;
  api_url?: string;
  dashboard_url?: string;
  team_id?: string;
  created_at?: string;
}

const DEFAULT_PATH = () => join(homedir(), ".pome", "credentials.json");

export function defaultCredentialsPath(): string {
  return DEFAULT_PATH();
}

/** Store after successful login: Keychain on macOS when possible, else file. */
export async function persistCredentialsAfterLogin(
  credentials: Required<
    Pick<CredentialsFile, "api_key" | "api_url" | "dashboard_url" | "team_id">
  >,
  path: string = DEFAULT_PATH(),
): Promise<{ stored: "keychain" | "file"; path?: string }> {
  if (keychainSupported()) {
    try {
      await writeKeychainCredentials(credentials);
      try {
        await rm(path, { force: true });
      } catch {
        /* ignore */
      }
      return { stored: "keychain" };
    } catch {
      /* fall through */
    }
  }
  await writeCredentialsFile(credentials, path);
  return { stored: "file", path };
}

export async function clearLocalCredentials(
  path: string = DEFAULT_PATH(),
): Promise<void> {
  await deleteKeychainCredentials();
  try {
    await rm(path, { force: true });
  } catch {
    /* ignore */
  }
}

export async function resolveCredentials(
  input: ResolveCredentialsInput,
): Promise<ResolvedCredentials> {
  const envKey = process.env.POME_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    const apiBaseUrl = resolveApiBaseUrl(input.apiBaseUrl, undefined);
    return { apiKey: envKey.trim(), apiBaseUrl };
  }

  const keychain = await readKeychainCredentials();
  if (
    keychain &&
    typeof keychain.api_key === "string" &&
    keychain.api_key.trim().length > 0
  ) {
    return {
      apiKey: keychain.api_key.trim(),
      apiBaseUrl: resolveApiBaseUrl(input.apiBaseUrl, keychain.api_url),
      teamId: normalizeTeamId(keychain.team_id),
    };
  }

  const path = input.credentialsPath ?? DEFAULT_PATH();
  let raw: string;
  try {
    await assertSafeCredentialFileMode(path);
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // F0-5c — surface this as a HostedAuthError so the top-level
      // exit-code mapper returns the documented 3 ("auth"). The previous
      // plain `Error` propagated to Commander's fallback and got
      // demoted to exit 2 ("twin/orch").
      throw new HostedAuthError(
        "Hosted mode requires authentication. Run `pome login`, set POME_API_KEY in your " +
          `environment, or sign in on macOS to store credentials in Keychain. Expected file: ${path}.`,
      );
    }
    throw err;
  }

  let parsed: CredentialsFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (
    typeof parsed.api_key !== "string" ||
    parsed.api_key.trim().length === 0
  ) {
    throw new Error(`${path} is missing "api_key".`);
  }
  return {
    apiKey: parsed.api_key.trim(),
    apiBaseUrl: resolveApiBaseUrl(input.apiBaseUrl, parsed.api_url),
    teamId: normalizeTeamId(parsed.team_id),
  };
}

function normalizeTeamId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveApiBaseUrl(
  callerInput: string | undefined,
  storedApiUrl: string | undefined,
): string {
  const candidate = callerInput ?? storedApiUrl;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(
      "Refusing to resolve hosted credentials: no apiBaseUrl supplied and no stored api_url found.",
    );
  }
  return normalizeBaseUrl(candidate);
}

async function assertSafeCredentialFileMode(path: string): Promise<void> {
  const st = await stat(path);
  const perm = st.mode & 0o777;
  if ((perm & 0o077) !== 0) {
    throw new Error(
      `Refusing to read credentials at ${path}: mode 0${perm.toString(8)} is too permissive (group/other bits must be 0). Run: chmod 600 ${path}`,
    );
  }
}

export async function writeCredentialsFile(
  credentials: Required<
    Pick<CredentialsFile, "api_key" | "api_url" | "dashboard_url" | "team_id">
  >,
  path: string = DEFAULT_PATH(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...credentials,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

function normalizeBaseUrl(raw: string): string {
  return new URL(raw).toString().replace(/\/$/, "");
}
