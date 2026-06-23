// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function stableNumericId(input: string) {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function makeSha(...parts: unknown[]) {
  return createHash("sha1")
    .update(JSON.stringify(parts))
    .update(randomUUID())
    .digest("hex");
}

export function fileSha(content: string) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

export function treeSha(paths: string[]) {
  return createHash("sha1").update(paths.sort().join("\n")).digest("hex");
}

export function encodeContent(content: string) {
  return Buffer.from(content, "utf8").toString("base64");
}

export function decodeMaybeBase64(content: string, encoding?: string) {
  if (encoding === "base64") {
    return Buffer.from(content, "base64").toString("utf8");
  }
  return content;
}

export function paginate<T>(items: T[], page = 1, perPage = 30) {
  const safePage = Math.max(1, page);
  const safePerPage = Math.min(100, Math.max(1, perPage));
  const start = (safePage - 1) * safePerPage;
  return items.slice(start, start + safePerPage);
}

export function requestId() {
  return `req_${randomUUID()}`;
}

export function linesChanged(before: string | undefined, after: string) {
  if (before === undefined) {
    return { additions: after.split("\n").filter(Boolean).length || 1, deletions: 0 };
  }
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let additions = 0;
  let deletions = 0;
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    if (oldLines[index] === newLines[index]) continue;
    if (newLines[index] !== undefined) additions += 1;
    if (oldLines[index] !== undefined) deletions += 1;
  }
  return { additions, deletions };
}
