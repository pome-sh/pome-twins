// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted variant of the seed compiler. Routes through the cloud control-plane's
 * `POST /v1/scenarios/compile-seed` endpoint instead of calling Anthropic
 * directly. Same `CompileResult` shape as the local compiler — callers can swap
 * one for the other transparently.
 *
 * Use cases:
 *  - users without an `ANTHROPIC_API_KEY` (let Pome bill it via subscription)
 *  - centralized model upgrades (cloud picks the model)
 *  - the future web-based scenario editor on app.pome.sh
 *
 * Endpoint contract: see `docs/agents/compile-seed-api.md`.
 */
import { z } from "zod";
import { resolveCredentials } from "../cli/credentials.js";
import { HostedAuthError, HostedOrchError, HostedQuotaError } from "../hosted/errors.js";
import { seedStateSchema } from "../twin/github/domain/seed.js";
import type { CompileResult } from "./seed-compiler.js";

const DEFAULT_TIMEOUT_MS = 60_000;

const responseSchema = z.object({
  seed: z.unknown(),
  source_hash: z.string(),
  model: z.string(),
  compiled_at: z.string(),
  cached: z.boolean().optional(),
  // Server can return usage metadata for transparency. Optional — older
  // server versions or cache-hit responses may omit it.
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost_cents: z.number().nonnegative().optional()
});

// Cloud's REST envelope is `{ error: { type, message, request_id } }` (see
// `cli/src/hosted/client.ts:110` for the canonical comment). Keep it permissive
// — older or unrelated origins (Hono default 401, edge errors) may not match.
const errorBodySchema = z.object({
  error: z
    .object({
      type: z.string().optional(),
      message: z.string().optional(),
      request_id: z.string().optional()
    })
    .optional()
});

export interface CompileSeedHostedOptions {
  apiBaseUrl: string;
  twin?: "github";
  scenarioPath?: string;
  timeoutMs?: number;
}

export async function compileSeedHosted(prose: string, opts: CompileSeedHostedOptions): Promise<CompileResult> {
  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const t0 = Date.now();

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${creds.apiBaseUrl}/v1/scenarios/compile-seed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": creds.apiKey,
        "user-agent": "pome-cli"
      },
      body: JSON.stringify({
        prose,
        twin: opts.twin ?? "github",
        scenario_path: opts.scenarioPath
      }),
      signal: controller.signal
    });
  } catch (err) {
    throw new HostedOrchError(
      `Could not reach the Pome control plane at ${creds.apiBaseUrl}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - t0;

  if (!res.ok) {
    await throwForStatus(res);
  }

  let parsed: z.infer<typeof responseSchema>;
  try {
    const body = await res.json();
    parsed = responseSchema.parse(body);
  } catch (err) {
    throw new HostedOrchError(
      `Control plane returned a response we could not parse: ${(err as Error).message}`
    );
  }

  // Re-validate the seed locally with the CLI's own schema. Catches transport
  // corruption and the (unlikely) case where cloud and CLI drift on schema.
  const seed = seedStateSchema.parse(parsed.seed);

  return {
    seed,
    inputTokens: parsed.input_tokens ?? 0,
    outputTokens: parsed.output_tokens ?? 0,
    model: parsed.model,
    durationMs
  };
}

async function throwForStatus(res: Response): Promise<never> {
  let body: z.infer<typeof errorBodySchema> = {};
  try {
    body = errorBodySchema.parse(await res.json());
  } catch {
    /* opaque body — fall through with empty */
  }
  const detail = body.error?.message ?? `HTTP ${res.status}`;
  const requestId = body.error?.request_id ?? res.headers.get("x-request-id") ?? undefined;

  if (res.status === 401 || res.status === 403) {
    throw new HostedAuthError(`Authentication failed: ${detail}`, requestId);
  }
  if (res.status === 402 || res.status === 429) {
    throw new HostedQuotaError(`Quota or rate limit hit: ${detail}`, requestId);
  }
  // F29 — a 502 from `/v1/scenarios/compile-seed` is overwhelmingly the
  // Vercel AI Gateway free-tier capacity error. The raw `detail` includes
  // a "vercel.com/d?to=..." URL and "Free tier users do not have access to
  // this model" verbiage — both leak vendor internals to the end-user and
  // tell them nothing actionable. Wrap with a concrete next step.
  if (res.status === 502) {
    throw new HostedOrchError(
      `Pome's hosted seed compiler hit a temporary capacity limit. ` +
        `Drop \`--hosted\` (or set ANTHROPIC_API_KEY then re-run \`pome compile-seeds --force\`) to compile locally via BYOK, or retry in a minute.`,
      requestId,
    );
  }
  throw new HostedOrchError(`Compile-seed failed (HTTP ${res.status}): ${detail}`, requestId);
}
