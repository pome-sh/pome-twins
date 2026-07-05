// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SHA256 = new Map([
  ["vendor/pome-sh-shared-types-0.3.0.tgz", "284ef36d0b8c138a3d66998916655962da8452ccd6882b3f2dfaf461e5c7a1b9"],
  ["vendor/pome-sh-twin-stripe-0.2.0.tgz", "bed2fdc0d6c92921079d21400fb60b0569897a124cf48e52fd9b0e1fbde76e5f"],
]);

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const declared = Object.values({
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
  ...(pkg.overrides ?? {}),
})
  .filter((value) => typeof value === "string" && value.startsWith("file:./vendor/"))
  .map((value) => value.slice("file:./".length));

const missingFromManifest = [...EXPECTED_SHA256.keys()].filter((path) => !declared.includes(path));
if (missingFromManifest.length > 0) {
  throw new Error(`Vendor manifest no longer references expected tarballs: ${missingFromManifest.join(", ")}`);
}

const undeclared = declared.filter((path) => !EXPECTED_SHA256.has(path));
if (undeclared.length > 0) {
  throw new Error(`Vendor tarballs must be added to scripts/verify-vendor.mjs: ${undeclared.join(", ")}`);
}

for (const [path, expected] of EXPECTED_SHA256) {
  const bytes = await readFile(resolve(root, path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Vendor checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

console.log(`Verified ${EXPECTED_SHA256.size} vendored tarballs.`);
