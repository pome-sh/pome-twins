#!/usr/bin/env bash
# Fails (exit 1) if any source file under packages/ imports from `pome-cloud`
# or `@pome-cloud/*`. Enforces ADR-002 open-core boundary in CI + pre-commit.
# String mentions (URLs, comments) are allowed; only import/require/dynamic-import
# syntax is rejected.

set -euo pipefail

PATTERN='(from[[:space:]]+|import[[:space:]]+|import\(|require\()[[:space:]]*['\''"]@?pome-cloud(/|['\''"])'

if matches=$(grep -rEn \
  --include='*.ts' --include='*.tsx' \
  --include='*.js' --include='*.jsx' \
  --include='*.mjs' --include='*.cjs' \
  -e "$PATTERN" \
  packages/); then
  echo "❌ Forbidden pome-cloud import detected (ADR-002 boundary violation):"
  echo "$matches"
  exit 1
fi

echo "✅ No pome-cloud imports in packages/"
