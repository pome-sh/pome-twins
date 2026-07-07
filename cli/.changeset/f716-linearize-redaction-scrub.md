---
"pome-sh": patch
---

The JWT and PEM-block redaction scrubs are rewritten as linear-time scanners
(F-716), resolving the CodeQL `js/polynomial-redos` alerts surfaced on the
F-681 engine extraction. Redaction output is byte-identical — boundary
behavior (JWTs glued mid-base64url-run, `.eyJ` prefixes, nested/incomplete
PEM blocks) is pinned by regression tests that pass against both the old and
new implementations, plus a seeded differential fuzz against the legacy
patterns. The redactor stays a byte-identical mirror across
`cli/src/recorder/redaction.ts`, `packages/adapter-claude-sdk`,
`packages/twin-github`, `packages/twin-slack`, and `packages/twin-stripe`,
with the same fix applied to the engine copy in `packages/sdk`.
