// SPDX-License-Identifier: Apache-2.0
//
// Shared trace redaction. This is the one implementation used by the CLI,
// adapter, SDK, and first-party twins before trace/state data is persisted,
// uploaded, or rendered in prompts.
const REDACTED = "[REDACTED]";

const HARD_REDACT_KEYS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "api_key",
  "client_secret",
  "webhook_secret",
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "session_token",
  "agent_token",
  "anthropic_api_key",
]);

function base64UrlRunEnd(value: string, from: number): number {
  let i = from;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    const isBase64Url =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;
    if (!isBase64Url) break;
    i += 1;
  }
  return i;
}

function scrubJwts(value: string): string {
  let out = "";
  let copied = 0;
  let search = 0;
  while (true) {
    const start = value.indexOf("eyJ", search);
    if (start === -1) break;
    const header = base64UrlRunEnd(value, start + 3);
    if (header === start + 3) {
      search = start + 1;
      continue;
    }
    if (value.charCodeAt(header) !== 46) {
      search = header;
      continue;
    }
    const payload = base64UrlRunEnd(value, header + 1);
    if (payload === header + 1 || value.charCodeAt(payload) !== 46) {
      search = header;
      continue;
    }
    const end = base64UrlRunEnd(value, payload + 1);
    out += value.slice(copied, start) + REDACTED;
    copied = end;
    search = end;
  }
  return copied === 0 ? value : out + value.slice(copied);
}

function pemHeaderEnd(value: string, at: number, keyword: string): number {
  const labelStart = at + keyword.length;
  let labelEnd = labelStart;
  while (labelEnd < value.length) {
    const code = value.charCodeAt(labelEnd);
    if (!((code >= 65 && code <= 90) || code === 32)) break;
    labelEnd += 1;
  }
  if (labelEnd === labelStart) return -1;
  if (!value.startsWith("-----", labelEnd)) return -1;
  return labelEnd + 5;
}

function scrubPemBlocks(value: string): string {
  let out = "";
  let copied = 0;
  let search = 0;
  while (true) {
    const begin = value.indexOf("-----BEGIN ", search);
    if (begin === -1) break;
    const bodyStart = pemHeaderEnd(value, begin, "-----BEGIN ");
    if (bodyStart === -1) {
      search = begin + 1;
      continue;
    }
    let endSearch = bodyStart;
    let blockEnd = -1;
    while (true) {
      const end = value.indexOf("-----END ", endSearch);
      if (end === -1) break;
      blockEnd = pemHeaderEnd(value, end, "-----END ");
      if (blockEnd !== -1) break;
      endSearch = end + 1;
    }
    if (blockEnd === -1) break;
    out += value.slice(copied, begin) + REDACTED;
    copied = blockEnd;
    search = blockEnd;
  }
  return copied === 0 ? value : out + value.slice(copied);
}

const SCRUB_STEPS: ReadonlyArray<RegExp | ((value: string) => string)> = [
  /redaction_fixture_secret_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:test|live)_[A-Za-z0-9_]{4,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[aboprs]-[A-Za-z0-9-]{20,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  /(?:pme|pk|rk)_[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  scrubJwts,
  scrubPemBlocks,
  /-----BEGIN [A-Z ]+-----/g,
];

function scrubString(value: string): string {
  let out = value;
  for (const step of SCRUB_STEPS) {
    out = typeof step === "function" ? step(out) : out.replace(step, REDACTED);
  }
  return out;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        HARD_REDACT_KEYS.has(key.toLowerCase()) ? REDACTED : redactSecrets(nested),
      ]),
    );
  }
  return value;
}

export function redactEvent<T>(event: T): T {
  return redactSecrets(event) as T;
}
