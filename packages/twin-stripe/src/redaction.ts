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

// F-716: the JWT and PEM-block scrubs used to be the regexes
// `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*` and
// `-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----`, which CodeQL flags
// as polynomial ReDoS: a failed attempt rescans the same text for every
// candidate start inside it (e.g. a long dotless "eyJeyJeyJ…" run). The two
// scanners below produce byte-identical output in linear time. Equivalence
// hinges on `.` and `-` being outside the quantified classes, so the old
// greedy runs could never benefit from backtracking: a match is always
// maximal-run + required-literal, which is exactly what the scanners test.

function base64UrlRunEnd(value: string, from: number): number {
  let i = from;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    const isBase64Url =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      code === 45 || // -
      code === 95; // _
    if (!isBase64Url) break;
    i += 1;
  }
  return i;
}

// Replaces every `eyJ<run>.<run>.<run?>` (runs are maximal base64url runs,
// the first two non-empty) with [REDACTED]. On failure the search resumes at
// the end of the runs already scanned: every other `eyJ` inside a scanned
// run shares that run's end, so it provably fails the same check.
function scrubJwts(value: string): string {
  let out = "";
  let copied = 0; // everything before this index is already in `out`
  let search = 0;
  while (true) {
    const start = value.indexOf("eyJ", search);
    if (start === -1) break;
    const header = base64UrlRunEnd(value, start + 3);
    if (header === start + 3) {
      search = start + 1;
      continue;
    }
    if (value.charCodeAt(header) !== 46 /* . */) {
      search = header;
      continue;
    }
    const payload = base64UrlRunEnd(value, header + 1);
    if (payload === header + 1 || value.charCodeAt(payload) !== 46 /* . */) {
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

// Matches `-----BEGIN <label>-----` / `-----END <label>-----` at `at`, where
// <label> is a maximal non-empty [A-Z ] run followed by five dashes. Returns
// the index just past the closing dashes, or -1.
function pemHeaderEnd(value: string, at: number, keyword: string): number {
  const labelStart = at + keyword.length;
  let labelEnd = labelStart;
  while (labelEnd < value.length) {
    const code = value.charCodeAt(labelEnd);
    if (!((code >= 65 && code <= 90) || code === 32)) break; // A-Z or space
    labelEnd += 1;
  }
  if (labelEnd === labelStart) return -1;
  if (!value.startsWith("-----", labelEnd)) return -1;
  return labelEnd + 5;
}

// Replaces every `-----BEGIN <label>-----…-----END <label>-----` block (lazy
// body: the earliest valid END wins) with [REDACTED]. If no valid END exists
// after a header, no later header can complete a block either (its END
// search space is a subset), so the scan stops instead of re-walking the
// tail once per dangling header. Dangling headers are still caught by the
// bare `-----BEGIN [A-Z ]+-----` pattern that runs after this scanner.
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

// `sk-...` covers OpenAI + Anthropic (`sk-ant-...`) + variants like `sk-proj-`.
// The leading boundary avoids mangling benign kebab-case words ending in "sk".
// `(s|r)k_(test|live)_...` covers Stripe secret/restricted keys (FDRS-588) —
// a shorter body threshold than the `pk`/`rk` rule below because seed keys like
// `sk_test_pome_a` are only a few chars past the prefix.
// `xapp-...` is a Slack app-level token; `AIza...` is a Google API key
// (FDRS-608). `g` flag matters: a single string may contain multiple secrets.
// Steps run in order; the two function steps are the F-716 linear scanners
// and must keep their slots (JWT and PEM-block scrub before the bare PEM
// header scrub).
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

// Public name used by events.jsonl writers. Same impl as redactSecrets — the
// alias exists so write sites read as "redact this event before persisting"
// rather than the generic "redact secrets."
export function redactEvent<T>(event: T): T {
  return redactSecrets(event) as T;
}
