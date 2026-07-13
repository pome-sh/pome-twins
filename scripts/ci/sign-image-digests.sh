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

  # Signature: enforce the RFC3161 timestamp (--use-signed-timestamps).
  # cosign v3 `sign` embeds it via the TUF signing config, so this passes at
  # build AND stays verifiable after the ~10min Fulcio cert expires — that
  # durably-timestamped signature is what the pome-cloud control-plane deploy
  # gate hard-requires (ADR-016 decision #4).
  echo "verifying $ref signature (with signed timestamps)"
  cosign verify \
    --use-signed-timestamps \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$issuer" \
    "$ref" >/dev/null
  # Attestation: NO --use-signed-timestamps. cosign `attest` (v3.1.1, latest)
  # emits no RFC3161 timestamp (no --new-bundle-format on attest), so requiring
  # one here fails the sign step on every run. The deploy gate treats the SPDX
  # attestation as best-effort for exactly this reason (ADR-016 decision #4);
  # verify it here while the cert is fresh (surfaces a bad/mis-signed SBOM at
  # build) without demanding a timestamp cosign cannot produce.
  echo "verifying $ref SPDX attestation"
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
