#!/usr/bin/env bash
# F-696 — assert public-repo policy for pome-twins main.
# Documents and verifies: PR required, 1 approving review, conversation
# resolution, no force-push/deletion, and always-present required checks.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pome-sh/pome-twins}"
BRANCH="${POLICY_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"

api() {
  curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

echo "Asserting branch protection for ${REPO}@${BRANCH}"

code="$(api -o /tmp/pome-twins-protection.json -w '%{http_code}' \
  "https://api.github.com/repos/${REPO}/branches/${BRANCH}/protection")"

if [[ "${code}" != "200" ]]; then
  echo "::error::branch ${BRANCH} is not protected (HTTP ${code})"
  cat /tmp/pome-twins-protection.json >&2 || true
  exit 1
fi

node <<'NODE'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("/tmp/pome-twins-protection.json", "utf8"));
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
  "ok: PR reviews, conversation resolution, no force-push/delete, required checks present",
);
console.log("required contexts:", contexts.join(", "));
NODE
