// SPDX-License-Identifier: Apache-2.0
// Centralized redactor applied at every events.jsonl write site (FDRS-401).
// Two layers, both unconditional:
//   1. Key-based: any field whose key matches the hard-redact list is replaced
//      with "[REDACTED]". `authorization`, `x-api-key`, and `cookie` are
//      required by the ticket; the other entries are pre-existing safeguards
//      against common secret-bearing field names that surfaced before FDRS-401.
//   2. Regex-based: scrub well-known credential shapes (API key prefixes,
//      JWTs, PEM blocks) anywhere inside string values, so secrets leaking
//      through OTLP attributes, ToolUseEvent args, or twin request bodies
//      are caught even when the field name is benign.
const REDACTED = "[REDACTED]";

const HARD_REDACT_KEYS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "api_key",
  "token",
  "access_token",
  "anthropic_api_key"
]);

// `sk-...` covers OpenAI + Anthropic (`sk-ant-...`) + variants like `sk-proj-`.
// `g` flag matters: a single string may contain multiple secrets.
const SCRUB_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /-----BEGIN [A-Z ]+-----/g
];

function scrubString(value: string): string {
  let out = value;
  for (const pattern of SCRUB_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        HARD_REDACT_KEYS.has(key.toLowerCase()) ? REDACTED : redactSecrets(nested)
      ])
    );
  }
  return value;
}

// Public name used by events.jsonl writers. Same impl as redactSecrets — the
// alias exists so write sites read as "redact this event before persisting"
// rather than the generic "redact secrets."
export function redactEvent<T>(event: T): T {
  return redactSecrets(event) as T;
}
