// SPDX-License-Identifier: Apache-2.0
//
// Shared fidelity:parity runner (F-730). One engine-level runner; each twin
// supplies declarative scenario data — an ordered, stateful chain of MCP
// calls with cross-call captures (a PR number, a charge id, a message ts) —
// plus its structured fidelity inventory. No per-twin runner copies (M1
// "twin-infra copies: 0" gate).
//
// The runner asserts three rings agree before it reports green:
//   1. live tool list (code truth from listTools())
//   2. fidelity.inventory.json tools (the machine-readable inventory)
//   3. scenario step coverage (every inventory tool exercised)
// and that every step answers its expected status through the frozen
// `POST /s/:sid/mcp/call` surface. Optional REST probes pin the loud-501
// unsupported envelope; an optional `live` hook lets a twin compare
// read-only shapes against the real upstream (e.g. `gh api`).

import { sign } from "hono/jwt";
import {
  compareToolNames,
  type FidelityInventory,
} from "./fidelity-inventory.js";

export type ParityState = Record<string, unknown>;

export interface ParityStep {
  tool: string;
  arguments?: Record<string, unknown> | ((state: ParityState) => Record<string, unknown>);
  /** Pull cross-call state (ids, numbers, shas) out of the response body. */
  capture?: (body: unknown, state: ParityState) => void;
  /** Expected HTTP status; default: any 2xx. */
  status?: number;
  /** Extra body assertion; return a problem string to fail the step. */
  verify?: (body: unknown) => string | undefined;
}

export interface ParityRestProbe {
  /** Label in the report, e.g. "unsupported-rest". */
  surface: string;
  method?: string;
  /** Session-relative path, e.g. "/repos/acme/api/actions/runs". */
  path: string;
  /** Expected HTTP status. */
  status: number;
  /** Assert the body carries a `fidelity: "unsupported"` marker. */
  expectUnsupportedEnvelope?: boolean;
}

export interface ParityAppLike {
  request(path: string | Request, init?: RequestInit): Response | Promise<Response>;
}

export interface RunParityOptions {
  app: ParityAppLike;
  twin: string;
  inventory: FidelityInventory;
  /** `listTools()` names from the twin source — the code truth. */
  liveToolNames: string[];
  steps: ParityStep[];
  restProbes?: ParityRestProbe[];
  /** Session id; default "fidelity-parity". */
  sid?: string;
  /** JWT secret; default env TWIN_AUTH_SECRET or the engine dev secret. */
  secret?: string;
  /** Extra JWT claims (login, team_id, account_id, ...). */
  claims?: Record<string, unknown>;
  /** Applied to every step without its own `verify` (twin error envelopes). */
  stepVerify?: (body: unknown) => string | undefined;
  /** Optional live upstream probes; entries are appended to the report. */
  live?: () => Promise<unknown[]>;
}

export interface ParityResult {
  ok: boolean;
  failures: string[];
  report: unknown[];
}

function bodyKeys(body: unknown): string[] {
  if (Array.isArray(body)) return ["array"];
  if (body && typeof body === "object") {
    return Object.keys(body as Record<string, unknown>).sort();
  }
  return [];
}

export async function runFidelityParity(options: RunParityOptions): Promise<ParityResult> {
  const sid = options.sid ?? "fidelity-parity";
  const secret = options.secret ?? process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";
  const token = await sign(
    { sid, exp: Math.floor(Date.now() / 1000) + 3600, ...options.claims },
    secret
  );
  const base = `/s/${sid}`;
  const failures: string[] = [];
  const report: unknown[] = [];

  // Ring 1 ⇔ ring 2: inventory tools must equal the live tool list.
  const inventoryNames = options.inventory.tools.map((entry) => entry.name);
  const inventoryDiff = compareToolNames(inventoryNames, options.liveToolNames);
  for (const name of inventoryDiff.missing) {
    failures.push(`tool '${name}' is live in listTools() but missing from fidelity.inventory.json`);
  }
  for (const name of inventoryDiff.extra) {
    failures.push(`tool '${name}' is in fidelity.inventory.json but not in listTools()`);
  }

  // Ring 2 ⇔ ring 3: every inventory tool needs at least one scenario step.
  const covered = new Set(options.steps.map((step) => step.tool));
  for (const name of inventoryNames) {
    if (!covered.has(name)) failures.push(`no parity scenario step covers tool '${name}'`);
  }
  for (const tool of covered) {
    if (!inventoryNames.includes(tool)) {
      failures.push(`scenario step calls '${tool}' which is not in fidelity.inventory.json`);
    }
  }

  const state: ParityState = {};
  for (const step of options.steps) {
    const args =
      typeof step.arguments === "function" ? step.arguments(state) : step.arguments ?? {};
    const response = await options.app.request(`${base}/mcp/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: step.tool, arguments: args }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    const expected = step.status === undefined ? response.ok : response.status === step.status;
    if (!expected) {
      failures.push(
        `${step.tool}: expected ${step.status ?? "2xx"}, got ${response.status} ${JSON.stringify(body).slice(0, 300)}`
      );
    } else {
      const problem = (step.verify ?? options.stepVerify)?.(body);
      if (problem) failures.push(`${step.tool}: ${problem}`);
      step.capture?.(body, state);
    }
    report.push({ tool: step.tool, status: response.status, ok: response.ok, keys: bodyKeys(body) });
  }

  for (const probe of options.restProbes ?? []) {
    const response = await options.app.request(`${base}${probe.path}`, {
      method: probe.method ?? "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (response.status !== probe.status) {
      failures.push(`${probe.surface}: expected ${probe.status}, got ${response.status}`);
    }
    if (probe.expectUnsupportedEnvelope && !JSON.stringify(body).includes('"fidelity":"unsupported"')) {
      failures.push(`${probe.surface}: body does not carry the fidelity:"unsupported" envelope`);
    }
    report.push({ surface: probe.surface, status: response.status, body });
  }

  if (options.live) {
    report.push(...(await options.live()));
  }

  return { ok: failures.length === 0, failures, report };
}

/** Script entrypoint: run, print the JSON report, set the exit code. */
export async function runParityCli(options: RunParityOptions): Promise<ParityResult> {
  const result = await runFidelityParity(options);
  console.log(
    JSON.stringify(
      {
        twin: options.twin,
        tools: options.inventory.tools.length,
        rest_surfaces: options.inventory.rest.length,
        ok: result.ok,
        failures: result.failures,
        report: result.report,
      },
      null,
      2
    )
  );
  if (!result.ok) {
    console.error(`fidelity:parity FAILED for ${options.twin} (${result.failures.length} problem(s))`);
    process.exitCode = 1;
  }
  return result;
}

export {
  compareToolNames,
  expandSurfaceCell,
  fidelityDocDriftSchema,
  fidelityInventorySchema,
  fidelitySurfaceSchema,
  heatTierSchema,
  lintFidelityInventory,
  loadFidelityInventory,
  parseFidelityDocRows,
} from "./fidelity-inventory.js";
export type {
  FidelityDocDrift,
  FidelityDocRow,
  FidelityDocSource,
  FidelityInventory,
  FidelitySurface,
  HeatTier,
} from "./fidelity-inventory.js";
