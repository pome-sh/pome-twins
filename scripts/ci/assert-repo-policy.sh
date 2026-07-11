#!/usr/bin/env bash
# F-696 — assert public-repo policy for pome-twins main.
#
# Split enforcement (classic + ruleset):
#   Classic branch protection: strict required checks, no force-push/delete.
#   Ruleset "main founder-bypass": PR + 1 approving review + conversation
#   resolution + the same required checks, with team `founder` as bypass actor
#   so founders can merge without an external approving review.
#
# GET .../branches/{branch}/protection and .../rulesets need Administration:read.
# The default Actions GITHUB_TOKEN cannot be granted that scope (invalid in
# workflow `permissions:`). Pass a fine-grained PAT via GITHUB_TOKEN /
# REPO_POLICY_TOKEN.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pome-sh/pome-twins}"
BRANCH="${POLICY_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required (fine-grained PAT with Administration: Read-only)}"
OUT="$(mktemp)"
RULESETS_OUT="$(mktemp)"
LIST_OUT="$(mktemp)"
trap 'rm -f "${OUT}" "${RULESETS_OUT}" "${LIST_OUT}"' EXIT

REQUIRED_CHECKS=(
  "typecheck-test"
  "gitleaks + trufflehog"
  "dependency review"
)
FOUNDER_TEAM_ID="16601595"
RULESET_NAME="main founder-bypass"

api() {
  curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

fail_http() {
  local code="$1"
  local label="$2"
  local dest="$3"
  if [[ "${code}" == "403" ]]; then
    echo "::error::HTTP 403 reading ${label} — token lacks Administration:read."
    echo "Create a fine-grained PAT (Administration: Read-only) and set repo secret REPO_POLICY_TOKEN."
    cat "${dest}" >&2 || true
    exit 1
  fi
  if [[ "${code}" == "404" ]]; then
    echo "::error::${label} not found (HTTP 404)"
    cat "${dest}" >&2 || true
    exit 1
  fi
  if [[ "${code}" != "200" ]]; then
    echo "::error::unexpected HTTP ${code} reading ${label}"
    cat "${dest}" >&2 || true
    exit 1
  fi
}

echo "Asserting classic protection + ruleset policy for ${REPO}@${BRANCH}"

if [[ -n "${POLICY_JSON:-}" ]]; then
  cp "${POLICY_JSON}" "${OUT}"
else
  code="$(api -o "${OUT}" -w '%{http_code}' \
    "https://api.github.com/repos/${REPO}/branches/${BRANCH}/protection")"
  fail_http "${code}" "branch protection for ${BRANCH}" "${OUT}"
fi

# List endpoint omits rules/bypass_actors — fetch the named ruleset by id.
# Offline fixtures pass a detailed rulesets array via RULESETS_JSON.
if [[ -n "${RULESETS_JSON:-}" ]]; then
  cp "${RULESETS_JSON}" "${RULESETS_OUT}"
else
  code="$(api -o "${LIST_OUT}" -w '%{http_code}' \
    "https://api.github.com/repos/${REPO}/rulesets")"
  fail_http "${code}" "repository rulesets" "${LIST_OUT}"

  RULESET_ID="$(RULESET_NAME="${RULESET_NAME}" LIST_OUT="${LIST_OUT}" node -e '
    const fs = require("fs");
    const list = JSON.parse(fs.readFileSync(process.env.LIST_OUT, "utf8"));
    const name = process.env.RULESET_NAME;
    const hit = Array.isArray(list) ? list.find((r) => r.name === name) : null;
    if (!hit?.id) {
      console.error(`::error::missing ruleset named "${name}"`);
      process.exit(1);
    }
    process.stdout.write(String(hit.id));
  ')"

  DETAIL="$(mktemp)"
  trap 'rm -f "${OUT}" "${RULESETS_OUT}" "${LIST_OUT}" "${DETAIL}"' EXIT
  code="$(api -o "${DETAIL}" -w '%{http_code}' \
    "https://api.github.com/repos/${REPO}/rulesets/${RULESET_ID}")"
  fail_http "${code}" "ruleset ${RULESET_ID}" "${DETAIL}"
  # Normalize to a one-element array for the shared validator.
  DETAIL="${DETAIL}" RULESETS_OUT="${RULESETS_OUT}" node -e '
    const fs = require("fs");
    const detail = JSON.parse(fs.readFileSync(process.env.DETAIL, "utf8"));
    fs.writeFileSync(process.env.RULESETS_OUT, JSON.stringify([detail]));
  '
fi

POLICY_JSON_PATH="${OUT}" \
RULESETS_JSON_PATH="${RULESETS_OUT}" \
REQUIRED_CHECKS_JSON="$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").trim().split(/\n/)))')" \
FOUNDER_TEAM_ID="${FOUNDER_TEAM_ID}" \
RULESET_NAME="${RULESET_NAME}" \
POLICY_BRANCH="${BRANCH}" \
node <<'NODE'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.env.POLICY_JSON_PATH, "utf8"));
const rulesets = JSON.parse(fs.readFileSync(process.env.RULESETS_JSON_PATH, "utf8"));
const required = JSON.parse(process.env.REQUIRED_CHECKS_JSON);
const founderTeamId = Number(process.env.FOUNDER_TEAM_ID);
const rulesetName = process.env.RULESET_NAME;
const branch = process.env.POLICY_BRANCH;
const errors = [];

function contextsFrom(statusChecks) {
  const contextList = statusChecks?.contexts;
  const checkList = statusChecks?.checks?.map((c) => c.context);
  return contextList?.length ? contextList : (checkList ?? []);
}

function patternMatchesBranch(pattern, branchName) {
  if (pattern === "~DEFAULT_BRANCH") return branchName === "main";
  const candidates = [branchName, `refs/heads/${branchName}`];
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return candidates.some((candidate) => regex.test(candidate));
}

function rulesetAppliesToBranch(ruleset, branchName) {
  if (String(ruleset.target).toLowerCase() !== "branch") return false;

  const refName = ruleset.conditions?.ref_name;
  if (!refName) return true;

  const includes = Array.isArray(refName.include) ? refName.include : [];
  const excludes = Array.isArray(refName.exclude) ? refName.exclude : [];
  const included = includes.length === 0 || includes.some((p) => patternMatchesBranch(p, branchName));
  const excluded = excludes.some((p) => patternMatchesBranch(p, branchName));
  return included && !excluded;
}

// --- Classic: checks + no force-push/delete (reviews live on the ruleset) ---
if (p.allow_force_pushes?.enabled !== false) {
  errors.push("classic allow_force_pushes must be false");
}
if (p.allow_deletions?.enabled !== false) {
  errors.push("classic allow_deletions must be false");
}
if (!p.required_status_checks) {
  errors.push("classic required_status_checks must be configured");
} else if (p.required_status_checks.strict !== true) {
  errors.push("classic required_status_checks.strict must be true");
}
const classicContexts = contextsFrom(p.required_status_checks);
for (const ctx of required) {
  if (!classicContexts.includes(ctx)) {
    errors.push(`classic missing required status check context: ${ctx}`);
  }
}

// --- Ruleset: PR reviews + conversation resolution + founder bypass ---
if (!Array.isArray(rulesets)) {
  errors.push("rulesets payload must be an array");
} else {
  const rs = rulesets.find((r) => r.name === rulesetName) ?? rulesets[0];
  if (!rs || rs.name !== rulesetName) {
    errors.push(`missing ruleset named "${rulesetName}"`);
  } else {
    if (String(rs.enforcement).toLowerCase() !== "active") {
      errors.push(`ruleset "${rulesetName}" must be active`);
    }
    if (!rulesetAppliesToBranch(rs, branch)) {
      errors.push(`ruleset "${rulesetName}" must target branch ${branch}`);
    }

    const bypass = rs.bypass_actors ?? [];
    const founderById = bypass.some(
      (a) =>
        a.actor_type === "Team" &&
        Number(a.actor_id) === founderTeamId &&
        String(a.bypass_mode || "always").toLowerCase() === "always",
    );
    if (!founderById) {
      errors.push(
        `ruleset "${rulesetName}" must bypass Team founder (id ${founderTeamId}) with mode always`,
      );
    }

    const rules = rs.rules ?? [];
    const prRule = rules.find((r) => r.type === "pull_request");
    if (!prRule?.parameters) {
      errors.push(`ruleset "${rulesetName}" must include a pull_request rule`);
    } else {
      const params = prRule.parameters;
      if (Number(params.required_approving_review_count) < 1) {
        errors.push("ruleset required_approving_review_count must be >= 1");
      }
      if (params.required_review_thread_resolution !== true) {
        errors.push("ruleset required_review_thread_resolution must be true");
      }
    }

    const checkRule = rules.find((r) => r.type === "required_status_checks");
    if (!checkRule?.parameters) {
      errors.push(`ruleset "${rulesetName}" must include required_status_checks`);
    } else {
      if (checkRule.parameters.strict_required_status_checks_policy !== true) {
        errors.push("ruleset strict_required_status_checks_policy must be true");
      }
      const rsContexts = (checkRule.parameters.required_status_checks ?? []).map(
        (c) => c.context,
      );
      for (const ctx of required) {
        if (!rsContexts.includes(ctx)) {
          errors.push(`ruleset missing required status check context: ${ctx}`);
        }
      }
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error("classic protection payload:", JSON.stringify(p, null, 2));
  console.error("rulesets payload:", JSON.stringify(rulesets, null, 2));
  process.exit(1);
}
console.log(
  "ok: classic checks + no force-push/delete; ruleset PR/reviews/conversations with founder bypass",
);
console.log("classic required contexts:", classicContexts.join(", "));
NODE
