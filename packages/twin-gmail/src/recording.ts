// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { RecorderEvent } from "@pome-sh/sdk";

export type BinaryProjection = { sha256: string; size: number };

export function projectGmailRecording(event: RecorderEvent): RecorderEvent {
  return {
    ...event,
    request_body: projectValue(event.request_body),
    response_body: projectValue(event.response_body),
    error: projectValue(event.error) as RecorderEvent["error"],
  };
}

function projectValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, key));
  if (isBinary(value)) return digest(Buffer.from(value));
  if (!value || typeof value !== "object") {
    return shouldProject(key) && typeof value === "string" ? digestEncoded(value, key) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = projectValue(child, childKey);
  }
  return out;
}

function shouldProject(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "raw" ||
    normalized === "canonicalraw" ||
    normalized === "canonical_raw" ||
    normalized === "attachmentdata" ||
    normalized === "attachment_data" ||
    normalized === "content" ||
    normalized === "data"
  );
}

function digestEncoded(value: string, key: string): BinaryProjection {
  const normalized = key.toLowerCase();
  if (
    normalized === "raw" ||
    normalized === "content" ||
    normalized === "data" ||
    normalized.includes("attachment")
  ) {
    try {
      if (normalized === "content" && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        return digest(Buffer.from(value, "base64"));
      }
      if (/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return digest(Buffer.from(value, "base64url"));
    } catch {
      // Fall through to exact UTF-8 bytes.
    }
  }
  return digest(Buffer.from(value, "utf8"));
}

function digest(value: Uint8Array): BinaryProjection {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    size: value.byteLength,
  };
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}
