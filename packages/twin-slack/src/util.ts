// SPDX-License-Identifier: Apache-2.0
//
// Slack-domain helpers only (F-683): wall-clock audit stamps, Slack's
// form-or-JSON body parsing, stringly-typed arg coercion, pagination
// cursors, and the Slack `ts` format. Request-id stamping moved to the
// engine's recorder with the port.
import type { Context } from "hono";

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Slack SDKs default to `application/x-www-form-urlencoded` request bodies;
 * MCP clients send `application/json`. We dispatch on content-type and accept
 * only those two (plus multipart/form-data). Any other or missing
 * content-type returns an empty object — callers that need a particular
 * field will surface a Zod validation error.
 *
 * Refusing to sniff bodies prevents JSON-typed values from being smuggled
 * via `Content-Type: text/plain` (etc.) into endpoints that assume
 * `args.foo` is a string after coerceFormValues.
 */
export async function parseFormOrJson(c: Context): Promise<Record<string, unknown>> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const body = await c.req.json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const body = await c.req.parseBody();
      return coerceFormValues(body);
    } catch {
      return {};
    }
  }
  return {};
}

function coerceFormValues(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  return out;
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (v === "1" || v === "true" || v === "yes") return true;
    if (v === "0" || v === "false" || v === "no") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export function csvList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function cursorEncode(payload: { offset: number }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function cursorDecode(cursor: string | undefined | null): { offset: number } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return { offset: parsed.offset as number };
    }
  } catch {
    // fall through
  }
  return null;
}

export function normalizeTs(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Slack ts shape: "<unix_seconds>.<6-digit-counter>"
  if (/^\d+\.\d{1,6}$/.test(value)) return value;
  return undefined;
}

// Base unix seconds for deterministic ts generation. Controlled by
// SLACK_DETERMINISTIC_TS=1 in tests so output is identical across runs.
export const DETERMINISTIC_TS_BASE_SECONDS = 1735689600; // 2025-01-01 UTC

export function tsBaseSeconds(): number {
  if (process.env.SLACK_DETERMINISTIC_TS === "1") return DETERMINISTIC_TS_BASE_SECONDS;
  return Math.floor(Date.now() / 1000);
}

export function padTsCounter(counter: number): string {
  return String(counter).padStart(6, "0");
}
