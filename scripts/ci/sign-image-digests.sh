#!/usr/bin/env bash
set -euo pipefail

summary_title="${1:?usage: sign-image-digests.sh <summary-title> <sbom-file>}"
sbom_file="${2:?usage: sign-image-digests.sh <summary-title> <sbom-file>}"

if [ ! -f "$sbom_file" ]; then
  echo "SBOM predicate not found: $sbom_file" >&2
  exit 1
fi

if [ -z "${IMAGE_TAGS:-}" ]; then
  echo "IMAGE_TAGS is required" >&2
  exit 1
fi

issuer="https://token.actions.githubusercontent.com"
identity_regexp="^https://github.com/${GITHUB_REPOSITORY:?}/\\.github/workflows/.*@refs/(heads|tags)/.*$"
signed_refs="$(mktemp)"
trap 'rm -f "$signed_refs"' EXIT

{
  echo "### $summary_title"
  echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

while IFS= read -r tag || [ -n "$tag" ]; do
  [ -n "$tag" ] || continue

  digest="$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}')"
  ref="${tag}@${digest}"

  echo "signing $ref"
  cosign sign --yes "$ref"
  cosign attest --yes --predicate "$sbom_file" --type spdx "$ref"

  echo "verifying $ref"
  cosign verify \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null
  cosign verify-attestation \
    --type spdx \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null

  echo "- \`$ref\`" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "$ref" >> "$signed_refs"
done <<< "$IMAGE_TAGS"

if [ ! -s "$signed_refs" ]; then
  echo "No image refs were signed" >&2
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "signed_digests<<EOF"
    cat "$signed_refs"
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
fi
