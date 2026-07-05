// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — anonymous demo session minting.
//
// POST {POME_API_BASE}/v1/demo/sessions with
//   { task_name: "first-run-demo", task_hash: "", group_id: "grp_…" }
// → { session_id, demo_token, expires_at }. No auth: the response's
// demo_token (a sid-scoped JWT) is the credential for everything that
// follows (gateway calls, blob uploads, finalize).
//
// All k sessions are minted UPFRONT (one shared group_id per invocation);
// each session's 15-minute TTL comfortably covers the whole k=5 run, so mint
// order is irrelevant. 402/429/503 map to DemoCapacityError so the CLI
// renders an honest labeled state.

import { z } from "zod";
import { HostedOrchError } from "../hosted/errors.js";
import { DemoCapacityError, capacityKindFrom, capacityLabel } from "./capacity.js";

export const demoSessionSchema = z.object({
  session_id: z.string().min(1),
  demo_token: z.string().min(1),
  expires_at: z.string(),
});
export type DemoSession = z.infer<typeof demoSessionSchema>;

export interface MintDemoSessionsOptions {
  apiBase: string;
  taskName: string;
  groupId: string;
  count: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function mintDemoSessions(
  options: MintDemoSessionsOptions,
): Promise<DemoSession[]> {
  const sessions: DemoSession[] = [];
  for (let i = 0; i < options.count; i += 1) {
    sessions.push(await mintOne(options));
  }
  return sessions;
}

async function mintOne(options: MintDemoSessionsOptions): Promise<DemoSession> {
  const doFetch = options.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await doFetch(`${options.apiBase}/v1/demo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_name: options.taskName,
        task_hash: "",
        group_id: options.groupId,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new HostedOrchError(
      err instanceof Error ? err.message : "network error",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = {};
  try {
    json = text.length ? JSON.parse(text) : {};
  } catch {
    throw new HostedOrchError(
      `POST /v1/demo/sessions returned non-JSON (status ${res.status})`,
    );
  }

  if (!res.ok) {
    const envelope = (
      json as {
        error?: { message?: string; details?: Record<string, unknown> };
      }
    ).error;
    // Mint 429 = per-IP daily session cap, 402 = house-team session quota
    // (neither carries a `kind` in details today — map by status).
    let kind = capacityKindFrom(res.status, envelope?.details?.kind);
    if (kind === "unknown_capacity") {
      kind = res.status === 429 ? "demo_ip_mint_cap" : "demo_mint_quota";
    }
    if (kind) {
      throw new DemoCapacityError(kind, envelope?.message ?? capacityLabel(kind));
    }
    throw new HostedOrchError(
      envelope?.message ?? `POST /v1/demo/sessions → HTTP ${res.status}`,
      undefined,
      res.status,
    );
  }

  const parsed = demoSessionSchema.safeParse(json);
  if (!parsed.success) {
    throw new HostedOrchError(
      `POST /v1/demo/sessions returned an unexpected shape: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
