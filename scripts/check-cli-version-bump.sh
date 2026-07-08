#!/usr/bin/env bash
# Fails (exit 1) if a PR touches `cli/src/**` or `cli/vendor/**` without either:
#   (a) a new changeset file under `cli/.changeset/*.md` (excluding README), OR
#   (b) a bump to `cli/package.json` version vs the base branch.
#
# Purpose: prevent the failure mode behind PR #93, where behavior changes
# shipped without a version bump so downstream users couldn't tell via
# `pome --version` whether their install picked up the new code. See FDRS-396.
#
# `cli/vendor/**` is covered because the CLI bundles vendored tarballs
# (@pome-sh/shared-types and the twin packages) via `bundleDependencies`.
# behavior change that ships to users, yet touches no file under cli/src/**;
# without this the gate is silent on twin swaps. See FDRS-593.
#
# Usage:
#   BASE_REF=origin/main scripts/check-cli-version-bump.sh
#
# In GitHub Actions, BASE_REF should be the PR's base SHA so the diff window
# matches the PR exactly.

set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "❌ BASE_REF '$BASE_REF' is not resolvable. Fetch it first." >&2
  exit 2
fi

# Was anything in cli/src/ or cli/vendor/ touched? Include deletions (D): dropping
# a vendored tarball (a bundleDependencies entry) is a shipping behavior change too.
# Capture to a variable first so that under `set -o pipefail` a grep-closed-pipe
# SIGPIPE on `git diff` can't be misread as "no changes" and silently skip the gate.
changed_files="$(git diff --name-only --diff-filter=ACMRTD "$BASE_REF"...HEAD)"
if ! grep -qE '^cli/(src|vendor)/' <<<"$changed_files"; then
  echo "✅ No changes under cli/src/ or cli/vendor/; CLI version-bump gate skipped."
  exit 0
fi

# (a) Was a new changeset file added under cli/.changeset/?
# Excludes README.md. Only counts ADDED files (not edits to existing ones).
new_changeset=0
if git diff --name-only --diff-filter=A "$BASE_REF"...HEAD \
   | grep -E '^cli/\.changeset/.+\.md$' \
   | grep -vE '^cli/\.changeset/README\.md$' \
   | grep -q .; then
  new_changeset=1
fi

# (b) Was cli/package.json version bumped vs BASE_REF?
version_bumped=0
head_version="$(node -p "require('./cli/package.json').version" 2>/dev/null || echo "")"
base_version="$(git show "$BASE_REF:cli/package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo "")"

if [[ -n "$head_version" && -n "$base_version" && "$head_version" != "$base_version" ]]; then
  version_bumped=1
fi

if [[ "$new_changeset" -eq 1 || "$version_bumped" -eq 1 ]]; then
  if [[ "$new_changeset" -eq 1 ]]; then
    echo "✅ Changeset entry found under cli/.changeset/."
  fi
  if [[ "$version_bumped" -eq 1 ]]; then
    echo "✅ cli/package.json version bumped: $base_version → $head_version"
  fi
  exit 0
fi

cat >&2 <<EOF
❌ CLI version-bump gate failed.

This PR touches cli/src/** or cli/vendor/** but neither:
  (a) added a changeset file under cli/.changeset/, NOR
  (b) bumped cli/package.json version (still $head_version on both sides).

Pick one before merging:

  # (preferred) record a changeset:
  cd cli && npm run changeset
  # ...write a one-line summary, pick patch/minor/major, commit the new file.

  # OR bump the version directly in cli/package.json:
  cd cli && npm version patch --no-git-tag-version

Why: PR #93 shipped 5 behavior changes without a bump and a downstream user
lost ~1h debugging whether their install picked up the fixes (pome --version
still reported the old version). Per FDRS-396, every behavior change to the
CLI must be reflected in the published version.
EOF
exit 1
