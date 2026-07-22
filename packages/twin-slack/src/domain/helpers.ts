// SPDX-License-Identifier: Apache-2.0

export function clampLimit(value: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

export function safeParseJson(raw: string | undefined | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function sanitizeJsonString(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    return fallback;
  }
}

export function normalizeReactionName(raw: string): string {
  return raw.trim().replace(/^:|:$/g, "");
}

export function filetypeMimetype(filetype: string): string {
  const mapping: Record<string, string> = {
    text: "text/plain",
    markdown: "text/markdown",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
  };
  return mapping[filetype] ?? "application/octet-stream";
}
