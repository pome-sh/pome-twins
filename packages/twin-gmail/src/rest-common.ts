// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { SessionValue } from "@pome-sh/sdk/server";
import { GmailError, invalidArgument, unsupported } from "./errors.js";
import { resolveUserEmail } from "./identity.js";

export type MessageFormat = "minimal" | "full" | "raw" | "metadata";
export type JsonObject = Record<string, unknown>;

const TOKEN_VERSION = 1;
const TOKEN_KEY = process.env.POME_GMAIL_PAGE_TOKEN_SECRET ?? "pome-gmail-page-token-v1";

export function emailFromContext(c: Context): string {
  return resolveUserEmail(routeParam(c, "userId"), c.get("session") as SessionValue | undefined);
}

export function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) invalidArgument(`Missing path parameter: ${name}`);
  return value;
}

export async function readJsonObject(c: Context): Promise<JsonObject> {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidArgument("Invalid request body");
    return value as JsonObject;
  } catch (error) {
    if (error instanceof GmailError) throw error;
    invalidArgument("Invalid JSON payload received.");
  }
}

export function stringField(body: JsonObject, name: string, required = false): string | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length === 0)) invalidArgument(`Invalid ${name}`);
  return value;
}

export function stringArray(body: JsonObject, name: string, limit = 100): string[] {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string")) {
    invalidArgument(`Invalid ${name}`);
  }
  return [...new Set(value as string[])];
}

export function objectField(body: JsonObject, name: string, required = false): JsonObject | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidArgument(`Invalid ${name}`);
  return value as JsonObject;
}

export function booleanQuery(c: Context, name: string, fallback = false): boolean {
  const value = c.req.query(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  invalidArgument(`Invalid value for ${name}`);
}

export function numberQuery(c: Context, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) invalidArgument(`Invalid value for ${name}`);
  return value;
}

export function repeatedQuery(c: Context, name: string): string[] {
  return new URL(c.req.url).searchParams.getAll(name);
}

export function messageFormat(c: Context, allowRaw = true): MessageFormat {
  const raw = (c.req.query("format") ?? "full").toLowerCase();
  const allowed = allowRaw ? ["minimal", "full", "raw", "metadata"] : ["minimal", "full", "metadata"];
  if (!allowed.includes(raw)) invalidArgument("Invalid format");
  return raw as MessageFormat;
}

export function rejectUnsupportedQuery(c: Context, names: string[]): void {
  for (const name of names) {
    if (booleanQuery(c, name, false)) unsupported(`${name}=true is not supported by the Gmail twin`);
  }
}

export function rejectClassification(body: JsonObject): void {
  if (body.addClassificationLabels !== undefined || body.removeClassificationLabelIds !== undefined) {
    unsupported("Gmail classification labels require Google Drive Labels and are not supported");
  }
}

export function normalizeListBinding(route: string, email: string, values: JsonObject): string {
  const canonical = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]);
  return createHash("sha256").update(JSON.stringify([route, email.toLowerCase(), canonical])).digest("hex");
}

export function paginate<T>(
  items: T[],
  options: { maxResults: number; pageToken?: string; binding: string; snapshot: string }
): { page: T[]; nextPageToken?: string } {
  const offset = options.pageToken
    ? decodePageToken(options.pageToken, options.binding, options.snapshot)
    : 0;
  if (offset > items.length) invalidArgument("Invalid page token");
  const page = items.slice(offset, offset + options.maxResults);
  const nextOffset = offset + page.length;
  return {
    page,
    ...(nextOffset < items.length
      ? { nextPageToken: encodePageToken(nextOffset, options.binding, options.snapshot) }
      : {}),
  };
}

function encodePageToken(offset: number, binding: string, snapshot: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: TOKEN_VERSION, o: offset, b: binding, s: snapshot }),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", TOKEN_KEY).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodePageToken(token: string, binding: string, snapshot: string): number {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) invalidArgument("Invalid page token");
  const expected = createHmac("sha256", TOKEN_KEY).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    invalidArgument("Invalid page token");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalidArgument("Invalid page token");
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JsonObject;
    if (
      parsed.v !== TOKEN_VERSION ||
      parsed.b !== binding ||
      parsed.s !== snapshot ||
      !Number.isInteger(parsed.o) ||
      (parsed.o as number) < 0
    ) {
      invalidArgument("Invalid page token");
    }
    return parsed.o as number;
  } catch (error) {
    if (error instanceof GmailError) throw error;
    invalidArgument("Invalid page token");
  }
}

export function asInputError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GmailError) throw error;
    invalidArgument(error instanceof Error ? error.message : "Invalid request");
  }
}

export function unsupportedResult(message: string): never {
  unsupported(message);
}
