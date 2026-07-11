#!/usr/bin/env bash
# F-696 — assert public-repo policy for pome-twins main.
# Documents and verifies: PR required, 1 approving review, conversation
# resolution, no force-push/deletion, strict required checks, and
# always-present required check contexts.
#
# GET .../branches/{branch}/protection needs Administration:read. The default
# Actions GITHUB_TOKEN cannot be granted that scope (invalid in workflow
# `permissions:`). Pass a fine-grained PAT via GITHUB_TOKEN / REPO_POLICY_TOKEN.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pome-sh/pome-twins}"
BRANCH="${POLICY_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required (fine-grained PAT with Administration: Read-only)}"
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT

api() {
  curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

echo "Asserting branch protection for ${REPO}@${BRANCH}"

if [[ -n "${POLICY_JSON:-}" ]]; then
  cp "${POLICY_JSON}" "${OUT}"
else
  code="$(api -o "${OUT}" -w '%{http_code}' \
    "https://api.github.com/repos/${REPO}/branches/${BRANCH}/protection")"

  if [[ "${code}" == "403" ]]; then
    echo "::error::HTTP 403 reading branch protection — token lacks Administration:read."
    echo "Create a fine-grained PAT (Administration: Read-only) and set repo secret REPO_POLICY_TOKEN."
    cat "${OUT}" >&2 || true
    exit 1
  fi
  if [[ "${code}" == "404" ]]; then
    echo "::error::branch ${BRANCH} is not protected (HTTP 404)"
    cat "${OUT}" >&2 || true
    exit 1
  fi
  if [[ "${code}" != "200" ]]; then
    echo "::error::unexpected HTTP ${code} reading branch protection for ${BRANCH}"
    cat "${OUT}" >&2 || true
    exit 1
  fi
fi

POLICY_JSON_PATH="${OUT}" node <<'NODE'
const fs = require("fs");
const path = process.env.POLICY_JSON_PATH;
const p = JSON.parse(fs.readFileSync(path, "utf8"));
const required = [
  "typecheck-test",
  "gitleaks + trufflehog",
  "dependency review",
];
const errors = [];

const reviews = p.required_pull_request_reviews;
if (!reviews || Number(reviews.required_approving_review_count) < 1) {
  errors.push("required_approving_review_count must be >= 1");
}
// Fail closed: missing fields mean we cannot prove the policy holds.
if (p.allow_force_pushes?.enabled !== false) {
  errors.push("allow_force_pushes must be false");
}
if (p.allow_deletions?.enabled !== false) {
  errors.push("allow_deletions must be false");
}

const conversation =
  p.required_conversation_resolution === true ||
  p.required_conversation_resolution?.enabled === true;
if (!conversation) {
  errors.push("required_conversation_resolution must be enabled");
}

if (!p.required_status_checks) {
  errors.push("required_status_checks must be configured");
} else if (p.required_status_checks.strict !== true) {
  errors.push("required_status_checks.strict must be true");
}

const contexts =
  p.required_status_checks?.contexts ??
  p.required_status_checks?.checks?.map((c) => c.context) ??
  [];
for (const ctx of required) {
  if (!contexts.includes(ctx)) {
    errors.push(`missing required status check context: ${ctx}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error("protection payload:", JSON.stringify(p, null, 2));
  process.exit(1);
}
console.log(
  "ok: PR reviews, conversation resolution, no force-push/delete, strict required checks present",
);
console.log("required contexts:", contexts.join(", "));
NODE
