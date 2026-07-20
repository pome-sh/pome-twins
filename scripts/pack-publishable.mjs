// SPDX-License-Identifier: Apache-2.0
//
// Build publishable npm tarballs for the public @pome-sh package set. The
// committed manifests stay convenient for in-repo development, while the staged
// package manifests always point at runnable dist JS and exact @pome-sh versions.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : join(repoRoot, "dist-tarballs"));

const packageDirs = [
  "packages/shared-types",
  "packages/sdk",
  "packages/adapter-claude-sdk",
  "packages/twin-github",
  "packages/twin-slack",
  "packages/twin-stripe",
  "packages/twin-gmail",
];

const sh = (cmd, cwd, extraArgs) =>
  execFileSync(cmd, extraArgs, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

const packageVersions = Object.fromEntries(
  packageDirs.map((rel) => {
    const pkg = readPkg(join(repoRoot, rel));
    return [pkg.name, pkg.version];
  }),
);

function build(pkgDir) {
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
  const local = join(pkgDir, "node_modules/.bin/tsc");
  const root = resolve(repoRoot, "node_modules/.bin/tsc");
  const tsc = existsSync(local) ? local : root;
  sh(tsc, pkgDir, ["-p", "tsconfig.build.json"]);
}

function npmPack(cwd) {
  const out = sh("npm", cwd, ["pack", "--silent"]);
  return out.trim().split("\n").pop().trim();
}

function rewritePomeDeps(deps = {}) {
  return Object.fromEntries(
    Object.entries(deps).map(([name, version]) => [
      name,
      packageVersions[name] ?? version,
    ]),
  );
}

function rewriteExports(exportsField, pkgDir) {
  if (!exportsField || typeof exportsField === "string") {
    return { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } };
  }

  const rewritten = {};
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (typeof target === "string") {
      const distTarget = target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
      const typeTarget = distTarget.replace(/\.js$/, ".d.ts");
      rewritten[subpath] = { types: typeTarget, default: distTarget };
      continue;
    }
    rewritten[subpath] = target;
  }

  if (!rewritten["."]) {
    rewritten["."] = { types: "./dist/index.d.ts", default: "./dist/index.js" };
  }

  return rewritten;
}

function rewriteMain(entry, fallback) {
  if (!entry) return fallback;
  return entry.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
}

function rewriteTypes(entry, fallback) {
  if (!entry) return fallback;
  return entry.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".d.ts");
}

function listFiles(root, dir = root) {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const rel = path.slice(root.length + 1);
      if (statSync(path).isDirectory()) return listFiles(root, path);
      return rel;
    })
    .sort();
}

function assertNoLocalSpecs(manifest, pkgName) {
  const text = JSON.stringify(manifest);
  if (text.includes("workspace:") || text.includes("file:")) {
    throw new Error(`${pkgName} publish manifest still contains a workspace: or file: spec`);
  }
}

function stage(pkgDir) {
  const staging = mkdtempSync(join(tmpdir(), "pome-pack-"));
  const pkg = readPkg(pkgDir);
  const keep = new Set(["dist", "package.json", ...(pkg.files ?? [])]);
  keep.delete("src");
  keep.delete("vendor");

  for (const entry of keep) {
    try {
      cpSync(join(pkgDir, entry), join(staging, entry), { recursive: true });
    } catch {
      // Optional entries such as README.md/FIDELITY.md are package-specific.
    }
  }

  const {
    devDependencies,
    bundledDependencies,
    bundleDependencies,
    scripts,
    ...rest
  } = pkg;

  const manifest = {
    ...rest,
    private: false,
    main: rewriteMain(pkg.main, "./dist/index.js"),
    types: rewriteTypes(pkg.types, "./dist/index.d.ts"),
    exports: rewriteExports(pkg.exports, pkgDir),
    dependencies: rewritePomeDeps(pkg.dependencies),
    files: listFiles(staging).filter((file) => file !== "package.json"),
  };

  if (pkg.bin) manifest.bin = pkg.bin;
  if (pkg.peerDependencies) manifest.peerDependencies = pkg.peerDependencies;
  if (pkg.peerDependenciesMeta) manifest.peerDependenciesMeta = pkg.peerDependenciesMeta;
  if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0) {
    delete manifest.dependencies;
  }
  manifest.files = [...new Set(["dist", ...manifest.files.filter((file) => !file.startsWith("dist/"))])];

  assertNoLocalSpecs(manifest, pkg.name);
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { staging, name: pkg.name, version: pkg.version };
}

mkdirSync(outDir, { recursive: true });
const results = {};

for (const rel of packageDirs) {
  const pkgDir = join(repoRoot, rel);
  build(pkgDir);
  const { staging, name, version } = stage(pkgDir);
  const tgz = npmPack(staging);
  cpSync(join(staging, tgz), join(outDir, tgz));
  results[name] = { tgz, version };
  rmSync(staging, { recursive: true, force: true });
}

console.error(`\nTarballs written to ${outDir}:`);
for (const { tgz } of Object.values(results)) console.error(`  ${tgz}`);
console.log(JSON.stringify(results));
