// SPDX-License-Identifier: Apache-2.0
//
// Point a package's `@pome-sh/*` dependencies at the locally-packed tarballs
// produced by `scripts/pack-publishable.mjs`, so CLI smoke/gate jobs can
// install and run *before* the packages exist on npm.
//
// Two things get rewritten:
//   1. Direct `@pome-sh/*` deps (dependencies + devDependencies) → `file:` tarball.
//   2. `overrides` for every packed package. This is the important part: each
//      packed twin's manifest pins its *own* deps to exact versions
//      (e.g. `@pome-sh/sdk@0.2.0`), so without an override npm resolves those
//      transitive pins from the real registry and 404s pre-publish.
//
// Usage: node scripts/use-local-pome-tarballs.mjs [package.json path]
//   POME_TARBALL_DIR overrides the tarball directory (default: $RUNNER_TEMP/tarballs).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const tarballDir =
  process.env.POME_TARBALL_DIR ?? join(process.env.RUNNER_TEMP ?? "/tmp", "tarballs");
const pkgPath = resolve(process.argv[2] ?? "package.json");

const tarballs = Object.fromEntries(
  readdirSync(tarballDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => {
      const pkgName = name
        .replace(/^pome-sh-/, "@pome-sh/")
        .replace(/-\d+\.\d+\.\d+.*\.tgz$/, "");
      return [pkgName, `file:${join(tarballDir, name)}`];
    }),
);

if (Object.keys(tarballs).length === 0) {
  throw new Error(`no @pome-sh/* tarballs found in ${tarballDir}`);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
for (const field of ["dependencies", "devDependencies"]) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (tarballs[name]) pkg[field][name] = tarballs[name];
  }
}
// Force transitive `@pome-sh/*` pins onto the local tarballs too.
pkg.overrides = { ...(pkg.overrides ?? {}), ...tarballs };

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `Rewrote ${Object.keys(tarballs).length} @pome-sh/* tarball(s) into ${pkgPath} (deps + overrides).`,
);
