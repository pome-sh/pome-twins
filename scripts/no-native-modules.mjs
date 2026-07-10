// SPDX-License-Identifier: Apache-2.0
//
// F-705 no-native-modules gate. "Zero native deps" (M2) is an invariant, not
// an event: no package in the PRODUCTION dependency closure of the published
// packages may carry a node-gyp build step. Detection is by gyp markers —
// a `binding.gyp` file or a truthy `gypfile` manifest field — NOT by
// `hasInstallScript`: prebuilt-binary installers (esbuild, fsevents) have
// install scripts but need no compiler, and must pass.
//
// Scope is the lockfile's non-dev entries (workspace transitives included).
// `dev` and `devOptional` entries are excluded: they never reach a
// production install (`npm ci --omit=dev`) or a published artifact.
// Run against a root whose `npm ci` has already populated node_modules —
// marker inspection needs the unpacked package on disk.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Intentional exceptions only; empty by design (same posture as the
// copy-marker gate's allowlist). Keys are lockfile package paths, e.g.
// "node_modules/some-package".
const ALLOWLIST = new Set([]);

export async function findNativeModules(root) {
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const offenders = [];
  const skippedOptional = [];
  let checked = 0;

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue; // the root project itself
    if (entry.link) continue; // workspace symlink; its deps have own entries
    if (entry.dev || entry.devOptional) continue; // not in the prod closure
    if (ALLOWLIST.has(path)) continue;

    const pkgDir = join(root, path);
    if (!existsSync(pkgDir)) {
      if (entry.optional) {
        // Platform-gated optional prod dep not installed here (e.g. another
        // OS's prebuilt binary package). Nothing to inspect on this machine.
        skippedOptional.push(path);
        continue;
      }
      throw new Error(
        `no-native-modules gate cannot inspect "${path}" — directory missing. ` +
          `Run npm ci in ${root} first.`,
      );
    }

    checked += 1;
    const markers = [];
    if (existsSync(join(pkgDir, "binding.gyp"))) markers.push("binding.gyp");
    try {
      const manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
      if (manifest.gypfile) markers.push('"gypfile": true');
    } catch {
      // Unreadable manifest: binding.gyp check above still applies.
    }
    if (markers.length > 0) offenders.push({ path, markers });
  }

  return { offenders, checked, skippedOptional };
}

// Run as a script (not when imported by the test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const rootArgIdx = process.argv.indexOf("--root");
  const root =
    rootArgIdx >= 0
      ? resolve(process.argv[rootArgIdx + 1])
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const { offenders, checked, skippedOptional } = await findNativeModules(root);
  if (offenders.length > 0) {
    console.error(
      "no-native-modules gate FAILED — native build step in the production closure:\n",
    );
    for (const { path, markers } of offenders) {
      console.error(`  ✗ ${path} (${markers.join(", ")})`);
    }
    console.error(
      "\nZero native deps is an M2 invariant: published packages must install " +
        "with no compiler toolchain. Replace the dependency or move it out of " +
        "the production closure.",
    );
    process.exit(1);
  }
  console.log(
    `no-native-modules gate passed — ${checked} production packages clean` +
      (skippedOptional.length > 0
        ? ` (${skippedOptional.length} platform-gated optional packages not installed here, skipped)`
        : ""),
  );
}
