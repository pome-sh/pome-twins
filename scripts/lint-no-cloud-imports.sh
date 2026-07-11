#!/usr/bin/env bash
# Fails (exit 1) if any source file under packages/, cli/src/, cli/scripts/,
# or repo-root scripts/ imports from `pome-cloud`, `pome-cloud/*`, or
# `@pome-cloud/*`. Enforces ADR-002 open-core boundary in CI + pre-commit.
# String mentions (URLs, comments) are allowed; only import/require/dynamic-import
# syntax is rejected.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERN='(from[[:space:]]+|import[[:space:]]+|import[[:space:]]*\(|require[[:space:]]*\()[[:space:]]*['\''"]@?pome-cloud(/|['\''"])'

SCAN_DIRS=()
for dir in packages cli/src cli/scripts scripts; do
  if [[ -d "${ROOT}/${dir}" ]]; then
    SCAN_DIRS+=("${ROOT}/${dir}")
  fi
done

if [[ ${#SCAN_DIRS[@]} -eq 0 ]]; then
  echo "❌ No scan directories found under ${ROOT}"
  exit 1
fi

if matches=$(grep -rEn \
  --include='*.ts' --include='*.tsx' \
  --include='*.js' --include='*.jsx' \
  --include='*.mjs' --include='*.cjs' \
  -e "$PATTERN" \
  "${SCAN_DIRS[@]}"); then
  echo "❌ Forbidden pome-cloud import detected (ADR-002 boundary violation):"
  echo "$matches"
  exit 1
fi

echo "✅ No pome-cloud imports in packages/, cli/src/, cli/scripts/, or scripts/"
