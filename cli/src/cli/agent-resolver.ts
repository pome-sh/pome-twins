// SPDX-License-Identifier: Apache-2.0
//
// The `POST /v1/agents` resolver round-trip (F-820), shared by `pome register`
// (interactive near-miss) and the run paths (silent re-resolution of a
// committed slug under the caller's team). Kept import-neutral — no register/
// session dependency — so both sides can consume it without a cycle.

import { createInterface } from "node:readline";

import { agentResponseSchema, type AgentResponse } from "@pome-sh/shared-types";

import { HostedAuthError, HostedOrchError } from "../hosted/errors.js";
import type { ResolvedCredentials } from "./credentials.js";

/** Test seams — default to a live TTY [y/N] prompt (mirrors install.ts). */
export interface InteractiveSeams {
  stdinIsTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

/** The manifest identity fields POSTed to the resolver. */
export interface AgentPostBody {
  name: string;
  slug?: string;
  description?: string;
  version?: string;
  framework?: string;
  twins?: string[];
  confirm?: boolean;
}

export function resolveSeams(opts: InteractiveSeams): Required<InteractiveSeams> {
  return {
    stdinIsTTY: opts.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    confirm: opts.confirm ?? promptYesNo,
  };
}

interface AgentHttpResult {
  ok: boolean;
  status: number;
  json: unknown;
}

async function requestAgent(
  creds: ResolvedCredentials,
  body: AgentPostBody,
): Promise<AgentHttpResult> {
  const res = await fetch(`${creds.apiBaseUrl}/v1/agents`, {
    method: "POST",
    headers: { "x-api-key": creds.apiKey, "content-type": "application/json" },
    body: JSON.stringify(prunePostBody(body)),
  }).catch((err: unknown) => {
    throw new HostedOrchError(err instanceof Error ? err.message : "network error");
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text.length ? JSON.parse(text) : {};
  } catch {
    throw new HostedOrchError(`non-JSON response (status ${res.status})`);
  }
  return { ok: res.ok, status: res.status, json };
}

/** Drop undefined keys so the wire body stays byte-clean (older cloud, tests). */
function prunePostBody(body: AgentPostBody): Record<string, unknown> {
  const out: Record<string, unknown> = { name: body.name };
  if (body.slug !== undefined) out.slug = body.slug;
  if (body.description !== undefined) out.description = body.description;
  if (body.version !== undefined) out.version = body.version;
  if (body.framework !== undefined) out.framework = body.framework;
  if (body.twins && body.twins.length > 0) out.twins = body.twins;
  if (body.confirm !== undefined) out.confirm = body.confirm;
  return out;
}

function parseOkAgent(json: unknown): AgentResponse {
  const parsed = agentResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new HostedOrchError("POST /v1/agents returned an unexpected shape");
  }
  return parsed.data;
}

function mapHttpError(status: number, json: unknown): Error {
  const err = (json as { error?: { message?: string; type?: string } }).error;
  if (status === 401 || status === 403) {
    return new HostedAuthError(err?.message ?? `HTTP ${status}`);
  }
  if (status === 404) {
    return new HostedOrchError(
      err?.message ??
        "POST /v1/agents is not available at this API URL. Upgrade pome-cloud or check that --api-url/POME_API_URL points at a version that supports agent registration.",
    );
  }
  return new HostedOrchError(err?.message ?? `POST /v1/agents → HTTP ${status}`);
}

/** Extract the near-miss suggested slug from a 409 conflict envelope. F-820
 *  returns it under `error.details.suggestion`; we also tolerate `suggestions[]`
 *  and `slug` as forward-compatible fallbacks. */
export function nearMissSuggestion(json: unknown): string | undefined {
  const error = (json as { error?: { type?: string; details?: Record<string, unknown> } }).error;
  if (error?.type !== "conflict") return undefined;
  const details = error.details;
  if (!details) return undefined;
  const candidate =
    details.suggestion ??
    details.slug ??
    (Array.isArray(details.suggestions) ? details.suggestions[0] : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** POST the manifest identity, resolving a 409 near-miss per the confirmation
 *  UX: interactive → "did you mean X?" (yes re-resolves X, no force-creates the
 *  typed slug); non-TTY/CI → warn + force-create (`confirm: true`). */
export async function postAgentResolver(
  creds: ResolvedCredentials,
  body: AgentPostBody,
  seams: Required<InteractiveSeams>,
): Promise<AgentResponse> {
  const first = await requestAgent(creds, body);
  if (first.ok) return parseOkAgent(first.json);

  if (first.status === 409) {
    const suggestion = nearMissSuggestion(first.json);
    if (suggestion) {
      const interactive = seams.stdinIsTTY && !process.env.CI;
      let retry: AgentPostBody;
      if (interactive) {
        const yes = await seams.confirm(
          `An agent named "${suggestion}" already exists on your team. Did you mean "${suggestion}"? [y/N] `,
        );
        retry = yes ? { ...body, slug: suggestion } : { ...body, confirm: true };
      } else {
        console.error(
          `Near-miss: this slug is close to your team's existing "${suggestion}". Registering the new agent anyway (run interactively to link the existing one instead).`,
        );
        retry = { ...body, confirm: true };
      }
      const second = await requestAgent(creds, retry);
      if (second.ok) return parseOkAgent(second.json);
      throw mapHttpError(second.status, second.json);
    }
  }
  throw mapHttpError(first.status, first.json);
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
