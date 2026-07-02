// SPDX-License-Identifier: Apache-2.0
// Guards FDRS-604: `docker compose up` writes each twin's secret to a per-twin
// subdir (`.pome-data/<twin>/secret`), so the agent's secret resolver must probe
// that path — not the legacy flat `.pome-data/secret`. Run with `bun test`.
import { afterEach, describe, expect, it } from "bun:test";
import { secretCandidatePaths } from "../src/index.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("secretCandidatePaths", () => {
  it("includes the per-twin github secret path (the compose default)", () => {
    delete process.env.POME_TWIN;
    delete process.env.POME_DATA_SECRET_PATH;
    const paths = secretCandidatePaths();
    expect(paths.some((p) => p.endsWith(".pome-data/github/secret"))).toBe(true);
  });

  it("also probes stripe and slack per-twin paths", () => {
    const paths = secretCandidatePaths();
    expect(paths.some((p) => p.endsWith(".pome-data/stripe/secret"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".pome-data/slack/secret"))).toBe(true);
  });

  it("keeps the legacy flat layout as a fallback", () => {
    const paths = secretCandidatePaths();
    expect(paths.some((p) => p.endsWith(".pome-data/secret"))).toBe(true);
  });

  it("probes the github (target twin) secret before other twins", () => {
    const paths = secretCandidatePaths();
    const perTwin = paths.filter((p) => /\.pome-data\/\w+\/secret$/.test(p));
    expect(perTwin[0]?.endsWith(".pome-data/github/secret")).toBe(true);
  });

  it("puts an explicit POME_DATA_SECRET_PATH first", () => {
    process.env.POME_DATA_SECRET_PATH = "/tmp/custom/secret";
    const paths = secretCandidatePaths();
    expect(paths[0]).toBe("/tmp/custom/secret");
  });

  it("returns a de-duplicated list", () => {
    const paths = secretCandidatePaths();
    expect(paths.length).toBe(new Set(paths).size);
  });
});
