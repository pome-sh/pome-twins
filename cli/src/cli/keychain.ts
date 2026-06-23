// SPDX-License-Identifier: Apache-2.0
/**
 * macOS Keychain helpers for hosted credentials (no extra native npm deps).
 * Uses the `security` CLI. On other platforms all functions no-op / return false.
 *
 * Service name is stable so `security` UI and docs can reference it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CredentialsFile } from "./credentials.js";

const execFileAsync = promisify(execFile);

const SERVICE = "sh.pome.cli";
const ACCOUNT = "hosted";

export function keychainSupported(): boolean {
  if (process.env.POME_CLI_DISABLE_KEYCHAIN === "1") return false;
  return process.platform === "darwin";
}

export async function writeKeychainCredentials(
  creds: Required<Pick<CredentialsFile, "api_key" | "api_url" | "dashboard_url" | "team_id">>,
): Promise<void> {
  if (!keychainSupported()) return;
  const payload = JSON.stringify({
    api_key: creds.api_key,
    api_url: creds.api_url,
    dashboard_url: creds.dashboard_url,
    team_id: creds.team_id,
    created_at: new Date().toISOString(),
  });
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    SERVICE,
    "-a",
    ACCOUNT,
    "-w",
    payload,
  ]);
}

export async function readKeychainCredentials(): Promise<CredentialsFile | null> {
  if (!keychainSupported()) return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
    ]);
    const text = stdout.trim();
    if (!text) return null;
    const parsed = JSON.parse(text) as CredentialsFile;
    if (typeof parsed.api_key !== "string" || !parsed.api_key.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteKeychainCredentials(): Promise<boolean> {
  if (!keychainSupported()) return false;
  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
    ]);
    return true;
  } catch {
    return false;
  }
}
