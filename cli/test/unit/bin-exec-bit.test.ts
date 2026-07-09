// SPDX-License-Identifier: Apache-2.0
// FDRS-666 — `npm pack` preserves file modes straight from disk, and a
// global install's `pome` bin symlink points at dist/src/cli/main.js. tsc
// emits 644, so without the build script's chmod the published CLI is
// unresolvable on PATH (`npm i -g pome-sh` → `pome` not found until a
// manual `chmod +x`). The npx path and project-local .bin shims exec via
// node and never caught this. Guard the built artifact's mode here —
// cli-ci runs `npm run build` before `npm test`, so dist/ exists in CI.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/src/cli/main.js",
);

describe("published bin exec bit (FDRS-666)", () => {
  // File modes are a POSIX concept and the publish packs on POSIX CI; skip
  // on Windows and on local checkouts that haven't built dist/ yet.
  it.skipIf(process.platform === "win32" || !existsSync(BIN))(
    "dist/src/cli/main.js carries the executable bit after build",
    () => {
      const mode = statSync(BIN).mode;
      expect(
        mode & 0o111,
        `dist/src/cli/main.js mode is 0${(mode & 0o777).toString(8)} — the build script's chmod is gone`,
      ).not.toBe(0);
    },
  );
});
