// SPDX-License-Identifier: Apache-2.0
//
// `withPome()` — the one-call init contract.
//
// Default behavior (no opts): infer twin allowlist from `POME_*_BASE_URL` and
// `POME_*_MCP_URL` env vars (CLI runner injects these when running scenarios).
// Standalone dev mode without env vars → empty allowlist, adapter inert on
// header injection but still wires ALS + signals fallback noop.

import { installFetchHook, getAllowlist, uninstallFetchHook } from "./fetch.js";

export interface WithPomeOptions {
  twinHosts?: string[];
}

let installed = false;

const ENV_PREFIXES_SUFFIXES: Array<[string, string]> = [
  ["POME_", "_BASE_URL"],
  ["POME_", "_MCP_URL"],
];

function inferTwinHostsFromEnv(): string[] {
  const out = new Set<string>();
  for (const [prefix, suffix] of ENV_PREFIXES_SUFFIXES) {
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const value = process.env[key];
      if (!value) continue;
      try {
        out.add(new URL(value).origin);
      } catch {
        /* ignore malformed env URL */
      }
    }
  }
  return [...out];
}

export function withPome(opts: WithPomeOptions = {}): void {
  if (installed) return;
  const twinHosts = opts.twinHosts ?? inferTwinHostsFromEnv();
  installFetchHook({ twinHosts });
  installed = true;
}

export function getInstalledTwinHosts(): string[] {
  return getAllowlist();
}

export function _resetInitForTest(): void {
  uninstallFetchHook();
  installed = false;
}
