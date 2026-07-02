// SPDX-License-Identifier: Apache-2.0
//
// Centralized redactor applied at every events.jsonl / trace write site
// (FDRS-401, FDRS-402, FDRS-588, FDRS-608). This file is a BYTE-IDENTICAL
// mirror kept in five places because these modules must not depend on each
// other:
//   - cli/src/recorder/redaction.ts
//   - packages/adapter-claude-sdk/src/redaction.ts
//   - packages/twin-github/src/redaction.ts
//   - packages/twin-slack/src/redaction.ts
//   - packages/twin-stripe/src/redaction.ts
// When this list grows, update EVERY mirror and keep them byte-identical.
//
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

// `sk-...` covers OpenAI + Anthropic (`sk-ant-...`) + variants like `sk-proj-`.
// The leading boundary avoids mangling benign kebab-case words ending in "sk".
// `(s|r)k_(test|live)_...` covers Stripe secret/restricted keys (FDRS-588) —
// a shorter body threshold than the `pk`/`rk` rule below because seed keys like
// `sk_test_pome_a` are only a few chars past the prefix.
// `xapp-...` is a Slack app-level token; `AIza...` is a Google API key
// (FDRS-608). `g` flag matters: a single string may contain multiple secrets.
const SCRUB_PATTERNS: RegExp[] = [
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
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /-----BEGIN [A-Z ]+-----/g,
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
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        HARD_REDACT_KEYS.has(key.toLowerCase()) ? REDACTED : redactSecrets(nested),
      ]),
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
