#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# eval-roundtrip.sh — manual, env-driven round-trip check for `pome eval`
# against a REAL pome-cloud deployment (D12 / F-689 remainder).
#
# This script is intentionally NOT wired into CI and carries NO secrets or
# defaults for POME_API_URL/POME_API_KEY — you must run it by hand, against a
# dev/staging cloud, with your own credentials, before undrafting a PR that
# touches the meta.json / upload-url contract (see the PR body checklist).
#
# What it does:
#   1. Records a fresh local trace with the bundled starter scenario + the
#      scripted example agent (`pome run --local`) — capture-only, no
#      network, no credentials needed for this half. `pome run` hard-gates
#      on `pome doctor`'s wiring checks with no --force, so this spins up a
#      disposable scaffold dir with a minimal pome.json manifest + a wiring
#      marker source (same technique as scripts/cas-adapter-acceptance.ts)
#      rather than bypassing the gate.
#   2. Uploads that trace with `pome eval <run-dir>` against POME_API_URL,
#      authenticated with POME_API_KEY, and prints whatever verdict the
#      cloud returns (`pome eval` already prints LABEL / score / criteria /
#      dashboard URL to the terminal — this script does not reimplement
#      that).
#
# Usage:
#   POME_API_URL=https://dev.api.pome.sh POME_API_KEY=pme_xxx \
#     cli/scripts/eval-roundtrip.sh
#
# Pass an existing run dir as $1 to skip step 1 and evaluate that instead:
#   POME_API_URL=... POME_API_KEY=... cli/scripts/eval-roundtrip.sh runs/01-bug-happy-path/run_abc123
#
# Exit code mirrors `pome eval`'s (0 pass, 1 fail/uneval, 2 orch, 3 auth,
# 4 quota, 5 usage) — see docs/05-api-spec.md's exit-code table.

set -euo pipefail

if [[ -z "${POME_API_URL:-}" ]]; then
  echo "eval-roundtrip.sh: POME_API_URL is not set (e.g. https://dev.api.pome.sh)" >&2
  exit 1
fi
if [[ -z "${POME_API_KEY:-}" ]]; then
  echo "eval-roundtrip.sh: POME_API_KEY is not set (a real team API key for POME_API_URL)" >&2
  exit 1
fi

CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLI_ROOT"

RUN_DIR="${1:-}"
EVAL_AGENT="${POME_EVAL_AGENT:-eval-roundtrip-script}"
POME_BIN="$CLI_ROOT/dist/src/cli/main.js"

if [[ -z "$RUN_DIR" ]]; then
  # `pome run` spawns the capture-server child by re-invoking
  # process.execPath/process.argv[1] (see overhead-gate.ts /
  # cas-adapter-acceptance.ts) — that re-invocation must be node-runnable, so
  # this needs the BUILT CLI, not tsx-from-source. Build fresh so a stale
  # dist/ never silently masks what this round-trip is meant to catch.
  echo "[eval-roundtrip] building the CLI (npm run build)…" >&2
  npm run build >&2

  ARTIFACTS_DIR="$(mktemp -d)"
  SCAFFOLD_DIR="$(mktemp -d)"
  # Both dirs are mktemp'd by THIS branch (no run dir was passed), so clean
  # both on exit. When $1 supplied a run dir we never enter here, so a
  # caller-owned artifacts dir is never removed.
  trap 'rm -rf "$SCAFFOLD_DIR" "$ARTIFACTS_DIR"' EXIT

  # FDRS-641 — `pome run`'s doctor preflight requires a pome.json manifest
  # (F-819: agent.slug + a top-level command) plus a routing-scan-friendly
  # source in the cwd. The REAL agent is passed via --agent below; this marker
  # file only exists so the wiring check has something to scan.
  cat > "$SCAFFOLD_DIR/pome.json" <<'EOF'
{
  "agent": { "slug": "eval-roundtrip-agent" },
  "command": "npx tsx agent.ts"
}
EOF
  cat > "$SCAFFOLD_DIR/agent.ts" <<'EOF'
// eval-roundtrip.sh doctor wiring marker — see cas-adapter-acceptance.ts for
// the same technique. Not actually executed; the real agent is --agent.
const baseUrl = process.env.POME_GITHUB_REST_URL;
void baseUrl;
export {};
EOF

  echo "[eval-roundtrip] no run dir given — recording a fresh local trace into $ARTIFACTS_DIR" >&2
  (
    cd "$SCAFFOLD_DIR"
    POME_LOCAL=1 node "$POME_BIN" run \
      "$CLI_ROOT/scenarios/01-bug-happy-path.md" \
      --local \
      --agent "npx tsx $CLI_ROOT/examples/agents/scripted-triage-agent.ts" \
      --artifacts-dir "$ARTIFACTS_DIR"
  )

  RUN_DIR="$(
    node -e '
      const fs = require("fs");
      const path = require("path");
      const dir = process.argv[1];
      const latest = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"));
      console.log(latest.run_dir);
    ' "$ARTIFACTS_DIR"
  )"
fi

echo "[eval-roundtrip] evaluating $RUN_DIR against $POME_API_URL (agent: $EVAL_AGENT)" >&2
node "$POME_BIN" eval "$RUN_DIR" --agent "$EVAL_AGENT" --api-url "$POME_API_URL"
