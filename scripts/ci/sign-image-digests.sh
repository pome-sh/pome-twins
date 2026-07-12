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
  # cosign v3 keyless embeds an RFC3161 signed timestamp automatically (TSA URL
  # from the TUF signing config). No --timestamp-server-url needed; that flag
  # was removed in v3 in favour of --use-signing-config (default true).
  cosign sign --yes "$ref"
  cosign attest --yes --predicate "$sbom_file" --type spdx "$ref"

  # --use-signed-timestamps REQUIRES an RFC3161 timestamp to be present and
  # valid. This is the load-bearing regression guard: without it, verification
  # here passes on the still-fresh Fulcio cert and the missing-timestamp defect
  # stays invisible until the cert expires (~10min) and a downstream consumer
  # (pome-cloud control-plane deploy gate) fails. Fail the build instead.
  echo "verifying $ref (with signed timestamps)"
  cosign verify \
    --use-signed-timestamps \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null
  cosign verify-attestation \
    --use-signed-timestamps \
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
