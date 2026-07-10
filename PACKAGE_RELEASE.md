# Package Release Flow

The CLI package (`@pome-sh/cli`) keeps using the existing Changesets flow in
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

## Versioning

Every `@pome-sh/*` package is pre-1.0, so npm's 0.x caret semantics apply
(`^0.N.x` never crosses into 0.N+1): **minor plays the major role**.

- **Minor (0.N+1.0)** — anything a consumer must act on: a change to the
  frozen runtime contract (`CONTRACT.md`, `/_pome/state` payloads), a
  published API signature change or removal, an `engines` floor bump, or a
  seed/state-schema change that invalidates existing recorded runs.
- **Patch (0.N.x)** — everything else: additive exports, internal
  implementation swaps behind an unchanged surface (e.g. the better-sqlite3 →
  node:sqlite driver swap, packages-v3), dependency-only bumps, bug fixes.

Judge by observable surface, not diff size. Internal `@pome-sh/*` consumers
pin exact versions, so the question is always the *external* surface — and
`npm run test:contract` is the arbiter: green means the contract surface did
not change and no minor is required.

A package goes 1.0 when its `CONTRACT.md` surface is frozen and pome-cloud
serves real customer sessions on it; from then on standard semver applies
(major = breaking).

`@pome-sh/cli` versions via Changesets (see `AGENTS.md`): patch = fixes and
internal changes, minor = new commands or flags, and any release whose
changelog entry leads with `BREAKING:` (e.g. an engines floor bump) is at
least a minor.

Twin image workflows publish GHCR digests only after tests and Trivy pass. Each
published digest is cosign-signed with GitHub OIDC and receives an SPDX SBOM
attestation; the pome-cloud snapshot promotion PR must pin and verify one of
those digests before rebuilding hosted snapshots.

Do not store `NPM_TOKEN` for these packages. Trusted Publishing must be
configured in npm for each `@pome-sh/*` package.
