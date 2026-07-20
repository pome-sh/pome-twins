// SPDX-License-Identifier: Apache-2.0
import { invalidArgument } from "./errors.js";
import { createHash } from "node:crypto";
import type { SeedAttachment } from "./types.js";

export type ParsedAttachment = {
  filename: string;
  mimeType: string;
  disposition: string;
  contentId?: string;
  data: Buffer;
};

export type ParsedMime = {
  headers: Array<{ name: string; value: string }>;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  deliveredTo: string;
  subject: string;
  date: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  text: string;
  html: string;
  attachments: ParsedAttachment[];
};

export type ComposeMimeInput = {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  date: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: SeedAttachment[];
};

const MAX_RAW_BYTES = 36_700_160;
const MAX_HEADERS = 1000;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_PARTS = 500;
const MAX_DEPTH = 20;

export function canonicalRaw(input: Uint8Array | string): Buffer {
  const raw = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (raw.length === 0) invalidArgument("MIME message is empty");
  if (raw.length > MAX_RAW_BYTES) invalidArgument(`MIME message exceeds ${MAX_RAW_BYTES} bytes`);
  return raw;
}

export function decodeGmailRaw(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(input)) invalidArgument("Invalid base64url MIME");
  const raw = Buffer.from(input, "base64url");
  // Strip trailing '=' without a quantifier regex — CodeQL js/polynomial-redos on /=+$/.
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 0x3d) end -= 1;
  if (raw.toString("base64url") !== input.slice(0, end)) invalidArgument("Invalid base64url MIME");
  return canonicalRaw(raw);
}

export function encodeGmailRaw(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

export function parseMime(input: Uint8Array | string): ParsedMime {
  const raw = canonicalRaw(input);
  const split = splitHeadBody(raw);
  const headers = parseHeaders(split.head);
  const rootType = parseContentType(header(headers, "content-type") ?? "text/plain; charset=utf-8");
  const state = { parts: 0, text: [] as string[], html: [] as string[], attachments: [] as ParsedAttachment[] };
  parsePart(split.body, headers, rootType, state, 0);
  return {
    headers,
    from: firstAddress(header(headers, "from") ?? ""),
    to: addresses(header(headers, "to") ?? ""),
    cc: addresses(header(headers, "cc") ?? ""),
    bcc: addresses(header(headers, "bcc") ?? ""),
    deliveredTo: firstAddress(header(headers, "delivered-to") ?? ""),
    subject: decodeWords(header(headers, "subject") ?? ""),
    date: normalizeDate(header(headers, "date")),
    messageId: normalizeMessageId(header(headers, "message-id") ?? ""),
    inReplyTo: normalizeMessageId(header(headers, "in-reply-to") ?? "") || undefined,
    references: messageIds(header(headers, "references") ?? ""),
    text: state.text.join("\n"),
    html: state.html.join("\n"),
    attachments: state.attachments,
  };
}

export function composeMime(input: ComposeMimeInput): Buffer {
  validateHeader(input.from);
  for (const value of [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])]) validateHeader(value);
  validateHeader(input.subject ?? "");
  const headers = [
    `From: ${input.from}`,
    ...(input.to?.length ? [`To: ${input.to.join(", ")}`] : []),
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Date: ${new Date(input.date).toUTCString()}`,
    `Message-ID: ${bracket(input.messageId)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${bracket(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(bracket).join(" ")}`] : []),
    `Subject: ${input.subject ?? ""}`,
    "MIME-Version: 1.0",
  ];
  const attachments = input.attachments ?? [];
  const text = input.text ?? "";
  const html = input.html ?? "";
  if (attachments.length === 0 && html === "") {
    return Buffer.from([...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n"));
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ ...input, attachments: attachments.map((a) => ({ ...a, data: sha256(decodeAttachmentData(a.data)) })) }))
    .digest("hex")
    .slice(0, 24);
  const mixed = `pome-mixed-${fingerprint}`;
  const alternative = `pome-alt-${fingerprint}`;
  const body: string[] = [...headers];
  if (attachments.length > 0) {
    body.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, "");
    if (html) {
      body.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, "");
      appendAlternative(body, alternative, text, html);
    } else {
      body.push(`--${mixed}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text);
    }
    for (const attachment of attachments) {
      validateHeader(attachment.filename);
      const data = decodeAttachmentData(attachment.data);
      body.push(
        `--${mixed}`,
        `Content-Type: ${attachment.mimeType ?? "application/octet-stream"}; name="${quoteParam(attachment.filename)}"`,
        `Content-Disposition: ${attachment.disposition ?? "attachment"}; filename="${quoteParam(attachment.filename)}"`,
        ...(attachment.contentId ? [`Content-ID: ${bracket(attachment.contentId)}`] : []),
        "Content-Transfer-Encoding: base64",
        "",
        foldBase64(data.toString("base64"))
      );
    }
    body.push(`--${mixed}--`, "");
  } else {
    body.push(`Content-Type: multipart/alternative; boundary="${alternative}"`, "");
    appendAlternative(body, alternative, text, html);
  }
  return Buffer.from(body.join("\r\n"), "utf8");
}

export function stripBcc(rawInput: Uint8Array): Buffer {
  const raw = Buffer.from(rawInput);
  const { head, body, separator } = splitHeadBody(raw);
  const lines = head.toString("latin1").split(/\r?\n/);
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc\s*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  return Buffer.concat([Buffer.from(kept.join(separator === "\r\n\r\n" ? "\r\n" : "\n"), "latin1"), Buffer.from(separator, "latin1"), body]);
}

export function normalizeSubject(subject: string): string {
  let value = subject.trim();
  while (/^(re|fwd?|aw|sv)\s*:/i.test(value)) value = value.replace(/^(re|fwd?|aw|sv)\s*:\s*/i, "");
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function mimeSha256(raw: Uint8Array): string {
  return sha256(raw);
}

function splitHeadBody(raw: Buffer): { head: Buffer; body: Buffer; separator: string } {
  let index = raw.indexOf(Buffer.from("\r\n\r\n"));
  let separator = "\r\n\r\n";
  if (index < 0) {
    index = raw.indexOf(Buffer.from("\n\n"));
    separator = "\n\n";
  }
  if (index < 0) invalidArgument("Malformed MIME: missing header/body separator");
  if (index > MAX_HEADER_BYTES) invalidArgument("MIME headers exceed limit");
  return { head: raw.subarray(0, index), body: raw.subarray(index + separator.length), separator };
}

function parseHeaders(raw: Buffer): Array<{ name: string; value: string }> {
  const lines = raw.toString("latin1").split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!unfolded.length) invalidArgument("Malformed folded MIME header");
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  if (unfolded.length > MAX_HEADERS) invalidArgument("MIME header count exceeds limit");
  return unfolded.map((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) invalidArgument("Malformed MIME header");
    const name = line.slice(0, colon).trim();
    if (!/^[!-9;-~]+$/.test(name)) invalidArgument("Malformed MIME header name");
    return { name, value: line.slice(colon + 1).trim() };
  });
}

function parsePart(
  body: Buffer,
  headers: Array<{ name: string; value: string }>,
  contentType: { type: string; params: Record<string, string> },
  state: { parts: number; text: string[]; html: string[]; attachments: ParsedAttachment[] },
  depth: number
): void {
  if (depth > MAX_DEPTH || ++state.parts > MAX_PARTS) invalidArgument("MIME nesting/part limit exceeded");
  if (contentType.type.startsWith("multipart/")) {
    const boundary = contentType.params.boundary;
    if (!boundary) invalidArgument("Multipart MIME missing boundary");
    for (const child of splitMultipart(body, boundary)) {
      const split = splitHeadBody(child);
      const childHeaders = parseHeaders(split.head);
      parsePart(
        split.body,
        childHeaders,
        parseContentType(header(childHeaders, "content-type") ?? "text/plain"),
        state,
        depth + 1
      );
    }
    return;
  }

  const transfer = (header(headers, "content-transfer-encoding") ?? "8bit").toLowerCase();
  const decoded = decodeTransfer(body, transfer);
  const disposition = parseDisposition(header(headers, "content-disposition") ?? "");
  const filename = disposition.params.filename ?? contentType.params.name ?? "";
  if (filename || disposition.type === "attachment" || header(headers, "content-id")) {
    state.attachments.push({
      filename: decodeWords(filename),
      mimeType: contentType.type,
      disposition: disposition.type || "attachment",
      contentId: normalizeMessageId(header(headers, "content-id") ?? "") || undefined,
      data: decoded,
    });
  } else if (contentType.type === "text/html") {
    state.html.push(decodeText(decoded, contentType.params.charset));
  } else if (contentType.type === "text/plain" || contentType.type === "message/rfc822") {
    state.text.push(decodeText(decoded, contentType.params.charset));
  }
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const marker = `--${boundary}`;
  const pieces = text.split(marker);
  if (pieces.length < 3) invalidArgument("Malformed multipart boundary");
  const out: Buffer[] = [];
  for (const piece of pieces.slice(1)) {
    if (piece.startsWith("--")) break;
    const trimmed = piece.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (trimmed) out.push(Buffer.from(trimmed, "latin1"));
  }
  return out;
}

function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const [rawType, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const item of rest) {
    const index = item.indexOf("=");
    if (index > 0) params[item.slice(0, index).trim().toLowerCase()] = unquote(item.slice(index + 1).trim());
  }
  return { type: (rawType ?? "text/plain").trim().toLowerCase(), params };
}

function parseDisposition(value: string): { type: string; params: Record<string, string> } {
  const parsed = parseContentType(value || "inline");
  return parsed;
}

function decodeTransfer(body: Buffer, transfer: string): Buffer {
  if (transfer === "base64") return Buffer.from(body.toString("ascii").replace(/\s/g, ""), "base64");
  if (transfer === "quoted-printable") {
    const text = body.toString("latin1").replace(/=\r?\n/g, "");
    return Buffer.from(text.replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  }
  return body;
}

function decodeText(data: Buffer, charset = "utf-8"): string {
  const normalized = charset.toLowerCase();
  if (normalized === "iso-8859-1" || normalized === "latin1") return data.toString("latin1");
  return data.toString("utf8");
}

function header(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((item) => item.name.toLowerCase() === name)?.value;
}

function addresses(value: string): string[] {
  return value
    .split(",")
    .map(firstAddress)
    .filter(Boolean);
}

function firstAddress(value: string): string {
  const angle = value.match(/<([^<>]+)>/);
  const candidate = (angle?.[1] ?? value).trim().replace(/^mailto:/i, "");
  return candidate.includes("@") ? candidate.toLowerCase() : "";
}

function messageIds(value: string): string[] {
  const matches = [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1]!);
  return matches.length ? matches : value.split(/\s+/).map(normalizeMessageId).filter(Boolean);
}

function normalizeMessageId(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("<")) normalized = normalized.slice(1);
  if (normalized.endsWith(">")) normalized = normalized.slice(0, -1);
  return normalized;
}

function normalizeDate(value: string | undefined): string {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_all, charset: string, encoding: string, data: string) => {
    const decoded =
      encoding.toLowerCase() === "b"
        ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
    return decodeText(decoded, charset);
  });
}

function appendAlternative(out: string[], boundary: string, text: string, html: string): void {
  out.push(
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    ""
  );
}

function decodeAttachmentData(data: string): Buffer {
  return Buffer.from(data, "base64");
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function validateHeader(value: string): void {
  if (/[\r\n\0]/.test(value)) invalidArgument("Header injection rejected");
}

function bracket(value: string): string {
  return `<${normalizeMessageId(value)}>`;
}

function quoteParam(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
