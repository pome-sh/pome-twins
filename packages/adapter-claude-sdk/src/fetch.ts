// SPDX-License-Identifier: Apache-2.0
//
// Global fetch hook with AsyncLocalStorage gating + host allowlist.
//
// Locked architecture (FDRS-322 [DECISION] 2026-05-11): we replace
// `globalThis.fetch` once at `withPome()` time. Each outbound request reads the
// current tool_call_id from ALS; if absent (i.e., outside a wrapped tool
// handler), the wrapper is a transparent passthrough — Anthropic SDK's
// internal calls to api.anthropic.com fall through cleanly because they
// originate outside the ALS scope. Host allowlist (origin-match) is the
// second gate: only configured twin origins get the x-pome-correlation-id
// header, never api.anthropic.com or third parties.

import { currentToolCallId } from "./als.js";

export const CORRELATION_HEADER = "x-pome-correlation-id";

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn | null = null;
let allowlistOrigins: Set<string> = new Set();

function normalizeOrigin(input: string): string | null {
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function isAllowed(input: Parameters<typeof globalThis.fetch>[0]): boolean {
  if (allowlistOrigins.size === 0) return false;
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else url = (input as Request).url;
  const origin = normalizeOrigin(url);
  return origin !== null && allowlistOrigins.has(origin);
}

export interface FetchHookOpts {
  twinHosts: string[];
}

export function installFetchHook(opts: FetchHookOpts): void {
  setAllowlist(opts.twinHosts);
  if (originalFetch !== null) return;
  originalFetch = globalThis.fetch;
  const wrapper: FetchFn = async (input, init) => {
    const toolCallId = currentToolCallId();
    if (!toolCallId || !isAllowed(input)) {
      return originalFetch!(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CORRELATION_HEADER, toolCallId);
    const nextInit: RequestInit = { ...(init ?? {}), headers };
    return originalFetch!(input, nextInit);
  };
  globalThis.fetch = wrapper;
}

export function uninstallFetchHook(): void {
  if (originalFetch === null) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  allowlistOrigins = new Set();
}

export function setAllowlist(hosts: string[]): void {
  allowlistOrigins = new Set(
    hosts.map(normalizeOrigin).filter((o): o is string => o !== null),
  );
}

export function getAllowlist(): string[] {
  return [...allowlistOrigins];
}
