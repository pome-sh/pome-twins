// SPDX-License-Identifier: Apache-2.0
// F-709 — read side of the F-708 secret contract in `pome twin start`:
// env-injected TWIN_AUTH_SECRET always wins, else the persisted
// `.pome-data/<twin>/secret` (POME_TWIN_DATA_DIR overrides the directory)
// is reused, else a per-boot ephemeral secret. Blank file = absent; a
// present-but-short secret fails loudly (mirrors the engine's
// readSecretFile rule — never mint against a weak HS256 key).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStandaloneAuthSecret } from "../../src/twin/twinStart.js";

const PERSISTED = "0123456789abcdef0123456789abcdef";

async function dataDirWithSecret(contents?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pome-twin-start-secret-"));
  if (contents !== undefined) await writeFile(join(dir, "secret"), contents);
  return dir;
}

describe("resolveStandaloneAuthSecret", () => {
  it("an env-injected TWIN_AUTH_SECRET wins over a persisted secret", async () => {
    const dir = await dataDirWithSecret(`${PERSISTED}\n`);
    const resolved = resolveStandaloneAuthSecret("github", {
      TWIN_AUTH_SECRET: "env-injected-secret",
      POME_TWIN_DATA_DIR: dir,
    });
    expect(resolved).toEqual({ secret: "env-injected-secret", source: "env" });
  });

  it("reads the persisted secret (trimmed) when the env is unset", async () => {
    const dir = await dataDirWithSecret(`${PERSISTED}\n`);
    const resolved = resolveStandaloneAuthSecret("github", { POME_TWIN_DATA_DIR: dir });
    expect(resolved).toEqual({
      secret: PERSISTED,
      source: "persisted",
      path: join(dir, "secret"),
    });
  });

  it("generates an ephemeral 32-byte hex secret when nothing is persisted", async () => {
    const dir = await dataDirWithSecret();
    const first = resolveStandaloneAuthSecret("github", { POME_TWIN_DATA_DIR: dir });
    const second = resolveStandaloneAuthSecret("github", { POME_TWIN_DATA_DIR: dir });
    expect(first.source).toBe("ephemeral");
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    // Per-boot, never persisted: two resolutions never agree.
    expect(second.secret).not.toBe(first.secret);
  });

  it("treats a blank persisted file as absent", async () => {
    const dir = await dataDirWithSecret("\n");
    const resolved = resolveStandaloneAuthSecret("github", { POME_TWIN_DATA_DIR: dir });
    expect(resolved.source).toBe("ephemeral");
  });

  it("refuses a persisted secret shorter than 32 chars", async () => {
    const dir = await dataDirWithSecret("too-short\n");
    expect(() =>
      resolveStandaloneAuthSecret("github", { POME_TWIN_DATA_DIR: dir }),
    ).toThrow(/shorter than 32 chars/);
  });

  it("defaults the data dir to .pome-data/<twin> (cwd-relative contract location)", () => {
    // No file exists at the contract location in the test cwd — the resolver
    // must fall through to ephemeral rather than throw on ENOENT.
    const resolved = resolveStandaloneAuthSecret("definitely-not-a-twin", {});
    expect(resolved.source).toBe("ephemeral");
  });
});
