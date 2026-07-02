// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SHA256 = new Map([
  ["vendor/pome-sh-correlator-0.1.0.tgz", "bf018970502bc08140dade8076cd60d9be8b7aaf81c092b62a35fd080f211002"],
  ["vendor/pome-sh-shared-types-0.3.0.tgz", "284ef36d0b8c138a3d66998916655962da8452ccd6882b3f2dfaf461e5c7a1b9"],
  ["vendor/pome-sh-twin-stripe-0.1.0.tgz", "cf77e6ac6e4df7fc37ec5fac68b61be3b0f4e6baf98c79f0a1852d41e9e2af19"],
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
