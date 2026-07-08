// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPackageDir = join(root, "packages/correlator");

if (existsSync(forbiddenPackageDir)) {
  throw new Error("packages/correlator must stay out of pome-twins; correlator ownership lives in pome-cloud.");
}

const scanRoots = ["packages", "cli/src", "cli/scripts"];
const forbidden = [
  /from\s+["']@pome-sh\/correlator(?:\/[^"']*)?["']/,
  /import\(["']@pome-sh\/correlator(?:\/[^"']*)?["']\)/,
  /require\(["']@pome-sh\/correlator(?:\/[^"']*)?["']\)/,
];
const violations = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (["node_modules", "dist", "test", "tests", "__fixtures__", "fixtures"].includes(entry)) continue;
      walk(abs, out);
      continue;
    }
    if (/\.(mjs|cjs|js|ts|tsx)$/.test(entry)) out.push(abs);
  }
  return out;
}

for (const scanRoot of scanRoots) {
  for (const file of walk(join(root, scanRoot))) {
    const text = readFileSync(file, "utf8");
    if (forbidden.some((re) => re.test(text))) {
      violations.push(relative(root, file).replaceAll("\\", "/"));
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Correlator runtime imports are not allowed in pome-twins:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
  );
}

console.log("No OSS correlator package or runtime imports found.");
