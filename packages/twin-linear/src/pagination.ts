// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { badUserInput } from "./errors.js";
import { RELAY_PAGE_DEFAULT, RELAY_PAGE_MAX } from "./types.js";

export type ConnectionArgs = {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
};

export type PageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor?: string | null;
};

export type Connection<T> = {
  nodes: T[];
  edges: Array<{ node: T; cursor: string }>;
  pageInfo: PageInfo;
};

let ephemeralSecret: string | undefined;

export function resolveCursorSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TWIN_AUTH_SECRET) {
    return createHash("sha256").update(`pome-linear-cursor:${env.TWIN_AUTH_SECRET}`).digest("hex");
  }
  ephemeralSecret ??= randomBytes(32).toString("hex");
  return ephemeralSecret;
}

export function connectionFromArray<T>(
  items: T[],
  args: ConnectionArgs = {},
  binding = "default",
  secret: string = resolveCursorSecret()
): Connection<T> {
  const beforeIndex = args.before != null ? decodeCursor(args.before, binding, secret) : items.length;
  const afterIndex = args.after != null ? decodeCursor(args.after, binding, secret) + 1 : 0;
  let start = Math.max(0, afterIndex);
  let end = Math.min(items.length, beforeIndex);

  if (typeof args.first === "number") {
    const first = clampPageSize(args.first);
    end = Math.min(end, start + first);
  } else if (typeof args.last === "number") {
    const last = clampPageSize(args.last);
    start = Math.max(start, end - last);
  } else {
    end = Math.min(end, start + RELAY_PAGE_DEFAULT);
  }

  const slice = items.slice(start, end);
  const edges = slice.map((node, offset) => ({
    node,
    cursor: encodeCursor(start + offset, binding, secret),
  }));

  const hasNextPage = end < items.length;
  const pageInfo: PageInfo = {
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: edges[0]?.cursor ?? null,
  };
  // Omit endCursor when exhausted — never emit empty-string cursors.
  if (hasNextPage && edges.length > 0) {
    pageInfo.endCursor = edges[edges.length - 1]!.cursor;
  } else if (edges.length > 0) {
    pageInfo.endCursor = null;
  }

  return { nodes: slice, edges, pageInfo };
}

export function encodeCursor(
  index: number,
  binding: string,
  secret: string = resolveCursorSecret()
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, i: index, b: binding }), "utf8").toString(
    "base64url"
  );
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function decodeCursor(
  cursor: string,
  binding: string,
  secret: string = resolveCursorSecret()
): number {
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra) badUserInput("Invalid pagination cursor");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    badUserInput("Invalid pagination cursor");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    badUserInput("Invalid pagination cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      i?: unknown;
      b?: unknown;
    };
    if (
      parsed.v !== 1 ||
      parsed.b !== binding ||
      !Number.isInteger(parsed.i) ||
      (parsed.i as number) < 0
    ) {
      badUserInput("Invalid pagination cursor");
    }
    return parsed.i as number;
  } catch (error) {
    if (error instanceof Error && error.name === "LinearTwinError") throw error;
    badUserInput("Invalid pagination cursor");
  }
}

export function clampPageSize(value: number, max = RELAY_PAGE_MAX, fallback = RELAY_PAGE_DEFAULT): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.trunc(value), max);
}

export function mcpPage(
  items: unknown[],
  limit: number | undefined,
  cursor: string | undefined,
  binding: string
): { items: unknown[]; cursor?: string } {
  const size = clampPageSize(limit ?? RELAY_PAGE_DEFAULT, RELAY_PAGE_MAX, RELAY_PAGE_DEFAULT);
  const offset = cursor ? decodeCursor(cursor, binding) : 0;
  if (offset > items.length) badUserInput("Invalid pagination cursor");
  const page = items.slice(offset, offset + size);
  const next = offset + page.length;
  return {
    items: page,
    ...(next < items.length ? { cursor: encodeCursor(next, binding) } : {}),
  };
}
