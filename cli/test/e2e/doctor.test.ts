// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — acceptance: all four doctor checks pass on a correctly wired
// copy of examples/triage-agent (the ticket's verification target). The
// example's real source is copied as-is; only pome.config.json is added —
// exactly what a user lands on after `pome install`.

import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorChecks } from "../../src/doctor/checks.js";

describe("pome doctor — wired triage-agent acceptance (FDRS-634)", () => {
  it("passes all four checks on a wired copy of examples/triage-agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-doctor-triage-"));
    const exampleSrc = new URL("../../../examples/triage-agent/src/", import.meta.url).pathname;
    await cp(exampleSrc, join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "pome.config.json"),
      JSON.stringify({ agent: { command: "npm start", sdk: "claude" } }, null, 2) + "\n",
    );

    const report = await runDoctorChecks({ cwd: dir, env: {} });
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:pass",
      "twin:pass",
      "routing:pass",
      "egress:pass",
    ]);
    expect(report.ok).toBe(true);
  }, 30_000);
});
