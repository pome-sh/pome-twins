# Package Release Flow

The CLI package (`pome-sh`) keeps using the existing Changesets flow in
`cli/`. Non-CLI packages are released as an explicit batch:

1. In a PR, update each changed package's `package.json` version and package
   changelog entry together. Keep internal `@pome-sh/*` dependencies pinned to
   the exact versions that will exist after the batch publishes.
2. Run `node scripts/pack-publishable.mjs --out dist-tarballs` and the clean-room
   smoke from `.github/workflows/sdk-publish.yml`.
3. After merge, create a GitHub Release whose tag starts with `packages-v`.
   The `package publish` workflow publishes `@pome-sh/shared-types`,
   `@pome-sh/sdk`, `@pome-sh/adapter-claude-sdk`, and the first-party twins with
   npm OIDC provenance.
4. Publish the CLI only after the exact package versions in `cli/package.json`
   exist on npm.

Twin image workflows publish GHCR digests only after tests and Trivy pass. Each
published digest is cosign-signed with GitHub OIDC and receives an SPDX SBOM
attestation; the pome-cloud snapshot promotion PR must pin and verify one of
those digests before rebuilding hosted snapshots.

Do not store `NPM_TOKEN` for these packages. Trusted Publishing must be
configured in npm for each `@pome-sh/*` package.
