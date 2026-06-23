// SPDX-License-Identifier: Apache-2.0
//
// Centralized secret redactor for recorder request_body / response_body.
// Mirrors `cli/src/recorder/redaction.ts` — same key set, same shape — so
// both the OSS twin and the CLI's vendored twin redact identically before
// any event lands in `events.jsonl`.
const SECRET_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api_key",
  "token",
  "access_token",
  "anthropic_api_key",
]);

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactSecrets(nested),
      ])
    );
  }

  return value;
}
