#!/usr/bin/env bash
# Point this clone's git hooks at the versioned hooks in scripts/hooks/.
# Idempotent — safe to re-run. Run once per clone:
#
#   bash scripts/hooks/install.sh
#
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

chmod +x scripts/hooks/pre-commit
git config core.hooksPath scripts/hooks

echo "✅ git hooks installed (core.hooksPath = scripts/hooks)"
echo "   pre-commit will run OSS boundary, copy-marker, and staged secret scans."
echo "   Install gitleaks + trufflehog locally before committing staged changes."
