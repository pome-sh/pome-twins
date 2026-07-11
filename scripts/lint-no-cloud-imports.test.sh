#!/usr/bin/env bash
# Regression fixtures for scripts/lint-no-cloud-imports.sh (F-696).
# Proves forbidden import forms fail, scan dirs are covered, and clean trees pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINT="${ROOT}/scripts/lint-no-cloud-imports.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "❌ $1" >&2
  exit 1
}

# Clean tree must pass.
bash "$LINT" >/dev/null || fail "clean tree unexpectedly failed"

assert_forbidden_in_dir() {
  local scan_rel="$1"
  local label="$2"
  local source="$3"
  local fake_root="${TMP}/fake-repo-${label}"
  mkdir -p "${fake_root}/${scan_rel}" "${fake_root}/scripts"
  cp "$LINT" "${fake_root}/scripts/lint-no-cloud-imports.sh"
  printf '%s\n' "$source" >"${fake_root}/${scan_rel}/bad.ts"

  if bash "${fake_root}/scripts/lint-no-cloud-imports.sh" >/dev/null 2>&1; then
    fail "expected failure for ${label} under ${scan_rel}"
  fi
  echo "✅ forbidden form rejected: ${label} (${scan_rel})"
  rm -rf "$fake_root"
}

# Import-form coverage (packages/).
assert_forbidden_in_dir packages "named-from-at-scope" "import { x } from '@pome-cloud/auth';"
assert_forbidden_in_dir packages "named-from-bare" "import { x } from 'pome-cloud/apps/control-plane';"
assert_forbidden_in_dir packages "bare-package" "import { x } from 'pome-cloud';"
assert_forbidden_in_dir packages "side-effect-import" "import 'pome-cloud/secret';"
assert_forbidden_in_dir packages "dynamic-import" "const m = await import('@pome-cloud/billing');"
assert_forbidden_in_dir packages "require" "const m = require('pome-cloud/foo');"

# Scan-dir coverage — each ADR-002 path must reject the same forbidden import.
BAD="import { x } from '@pome-cloud/auth';"
assert_forbidden_in_dir packages "scan-packages" "$BAD"
assert_forbidden_in_dir cli/src "scan-cli-src" "$BAD"
assert_forbidden_in_dir cli/scripts "scan-cli-scripts" "$BAD"
assert_forbidden_in_dir scripts "scan-scripts" "$BAD"

# Comments / strings must still pass.
COMMENT_ROOT="${TMP}/fake-repo-comments"
mkdir -p "${COMMENT_ROOT}/packages" "${COMMENT_ROOT}/scripts"
cp "$LINT" "${COMMENT_ROOT}/scripts/lint-no-cloud-imports.sh"
cat >"${COMMENT_ROOT}/packages/ok.ts" <<'EOF'
// See pome-cloud for hosted evaluation.
const url = "https://github.com/pome-sh/pome-cloud";
export const note = 'do not import pome-cloud';
EOF
bash "${COMMENT_ROOT}/scripts/lint-no-cloud-imports.sh" >/dev/null \
  || fail "comments/strings unexpectedly failed"

echo "✅ lint-no-cloud-imports fixtures passed"
