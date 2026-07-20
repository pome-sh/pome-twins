// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";
import { invalidArgument, unsupported } from "./errors.js";
import { asInputError, objectField, readJsonObject, stringField, type JsonObject } from "./rest-common.js";

export type MessageWriteInput = {
  raw: string | Uint8Array;
  threadId?: string;
  id?: string;
  labelIds?: string[];
};

export async function readMessageWrite(c: Context, draftEnvelope = false): Promise<MessageWriteInput> {
  if (isResumable(c)) unsupported("Resumable Gmail uploads are not supported");
  const contentType = c.req.header("content-type") ?? "";
  if (/^multipart\/related\b/i.test(contentType)) {
    const { metadata, media } = await readMultipart(c, contentType);
    const resource = draftEnvelope ? objectField(metadata, "message") ?? metadata : metadata;
    rejectMessageExtensions(resource);
    return {
      raw: media,
      threadId: stringField(resource, "threadId"),
      id: stringField(metadata, "id"),
      labelIds: stringList(resource, "labelIds"),
    };
  }
  if (!/^application\/json\b/i.test(contentType) && !/^text\/json\b/i.test(contentType)) {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length) invalidArgument("MIME message is empty");
    return { raw: bytes };
  }
  const body = await readJsonObject(c);
  const resource = draftEnvelope ? objectField(body, "message", true)! : body;
  rejectMessageExtensions(resource);
  return {
    raw: stringField(resource, "raw", true)!,
    threadId: stringField(resource, "threadId"),
    id: stringField(body, "id"),
    labelIds: stringList(resource, "labelIds"),
  };
}

function rejectMessageExtensions(resource: JsonObject): void {
  if (resource.classificationLabelValues !== undefined) {
    unsupported("Gmail classification labels require Google Drive Labels and are not supported");
  }
}

function stringList(body: JsonObject, name: string): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string")) {
    invalidArgument(`Invalid ${name}`);
  }
  return [...new Set(value as string[])];
}

export async function readDraftSend(c: Context): Promise<{ id?: string; message?: MessageWriteInput }> {
  const contentType = c.req.header("content-type") ?? "";
  if (/^application\/json\b/i.test(contentType) || /^text\/json\b/i.test(contentType)) {
    const body = await readJsonObject(c);
    const id = stringField(body, "id");
    const message = objectField(body, "message");
    if (!id && !message) invalidArgument("Draft id is required");
    return {
      id,
      ...(message
        ? {
            message: {
              raw: stringField(message, "raw", true)!,
              threadId: stringField(message, "threadId"),
            },
          }
        : {}),
    };
  }
  return { message: await readMessageWrite(c, false) };
}

function isResumable(c: Context): boolean {
  return c.req.path.startsWith("/resumable/") || c.req.query("uploadType") === "resumable";
}

async function readMultipart(c: Context, contentType: string): Promise<{ metadata: JsonObject; media: Buffer }> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!boundary) invalidArgument("Multipart upload is missing a boundary");
  const bytes = Buffer.from(await c.req.arrayBuffer());
  const parts = splitMultipart(bytes, boundary);
  if (parts.length !== 2) invalidArgument("Multipart upload must contain metadata and MIME media");
  let metadata: JsonObject;
  try {
    metadata = JSON.parse(parts[0]!.body.toString("utf8")) as JsonObject;
  } catch {
    invalidArgument("Invalid multipart metadata JSON");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalidArgument("Invalid multipart metadata JSON");
  if (!parts[1]!.body.length) invalidArgument("MIME message is empty");
  return { metadata, media: parts[1]!.body };
}

function splitMultipart(bytes: Buffer, boundary: string): Array<{ headers: string; body: Buffer }> {
  return asInputError(() => {
    const marker = Buffer.from(`--${boundary}`);
    const endMarker = Buffer.from(`--${boundary}--`);
    const parts: Array<{ headers: string; body: Buffer }> = [];
    let cursor = 0;
    while (cursor < bytes.length) {
      const start = bytes.indexOf(marker, cursor);
      if (start < 0 || bytes.subarray(start, start + endMarker.length).equals(endMarker)) break;
      const lineEnd = bytes.indexOf(Buffer.from("\n"), start + marker.length);
      if (lineEnd < 0) throw new Error("Malformed multipart upload");
      const next = bytes.indexOf(marker, lineEnd + 1);
      if (next < 0) throw new Error("Malformed multipart upload");
      let chunk = bytes.subarray(lineEnd + 1, next);
      while (chunk.length && (chunk.at(-1) === 10 || chunk.at(-1) === 13)) chunk = chunk.subarray(0, -1);
      const crlf = chunk.indexOf(Buffer.from("\r\n\r\n"));
      const lf = chunk.indexOf(Buffer.from("\n\n"));
      const separator = crlf >= 0 ? { index: crlf, length: 4 } : { index: lf, length: 2 };
      if (separator.index < 0) throw new Error("Malformed multipart upload");
      parts.push({
        headers: chunk.subarray(0, separator.index).toString("latin1"),
        body: Buffer.from(chunk.subarray(separator.index + separator.length)),
      });
      cursor = next;
    }
    return parts;
  });
}
