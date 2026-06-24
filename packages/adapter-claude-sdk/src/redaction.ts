// SPDX-License-Identifier: Apache-2.0
//
// Mirrors `cli/src/recorder/redaction.ts` (FDRS-401). Duplicated in-package
// because `@pome-sh/adapter-claude-sdk` does not depend on the CLI — same
// precedent as `packages/twin-github/src/redaction.ts` (FDRS-402). When this
// list grows, update every mirror.

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

const SCRUB_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[aboprs]-[A-Za-z0-9-]{20,}/g,
  /(?:pme|pk|rk)_[A-Za-z0-9_-]{20,}/g,
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
      Object.entries(value).map(([key, nested]) => [
        key,
        HARD_REDACT_KEYS.has(key.toLowerCase()) ? REDACTED : redactSecrets(nested),
      ]),
    );
  }
  return value;
}
