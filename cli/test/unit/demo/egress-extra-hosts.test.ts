// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — demo-mode egress valve: the POME_API_BASE host joins the
// deny-by-default floor's allowlist so the bundled agent's gateway CONNECTs
// aren't refused, without opening anything else.
import { describe, expect, it } from "vitest";
import {
  buildEgressAllowlist,
  isHostAllowed,
} from "../../../src/capture-server/egress.js";

describe("buildEgressAllowlist extraHosts (FDRS-643)", () => {
  it("adds the demo gateway host on top of the default provider set", () => {
    const allow = buildEgressAllowlist({}, { extraHosts: ["api.pome.sh"] });
    expect(allow).toContain("api.pome.sh");
    // Defaults survive.
    expect(allow).toContain("ai-gateway.vercel.sh");
    expect(isHostAllowed("api.pome.sh", allow)).toBe(true);
    // The valve is surgical: no wildcard leak.
    expect(isHostAllowed("evil.example.com", allow)).toBe(false);
    expect(isHostAllowed("app.pome.sh", allow)).toBe(false);
  });

  it("normalizes + dedupes extra hosts like every other source", () => {
    const allow = buildEgressAllowlist(
      { POME_EGRESS_ALLOW: "api.pome.sh" },
      { extraHosts: ["API.POME.SH."] },
    );
    expect(allow.filter((h) => h === "api.pome.sh")).toHaveLength(1);
  });

  it("no extraHosts → behavior unchanged", () => {
    const withOpt = buildEgressAllowlist({}, {});
    const without = buildEgressAllowlist({});
    expect(withOpt).toEqual(without);
    expect(isHostAllowed("api.pome.sh", without)).toBe(false);
  });
});
