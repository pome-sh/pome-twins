// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
);

test("@hono/node-server is a runtime dependency (Docker --omit=dev)", () => {
  assert.ok(
    pkg.dependencies?.["@hono/node-server"],
    "server.js dynamically imports @hono/node-server; it must not live only in devDependencies",
  );
  assert.equal(pkg.devDependencies?.["@hono/node-server"], undefined);
});
