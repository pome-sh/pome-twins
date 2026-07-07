// SPDX-License-Identifier: Apache-2.0
//
// Provider-shaped token mechanism tests (F-681, spec = F-712 [DECISION] row 1
// + row 10 + the appendix bug). The engine owns mint + verify; twins declare
// only their token shape (prefixes + HMAC provider domain).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mintProviderToken,
  verifyProviderToken,
  type ProviderTokenSpec,
} from "../src/auth.js";

const SECRET = "provider-test-secret";

const slackSpec: ProviderTokenSpec = {
  provider: "slack",
  prefixes: ["xoxb-pome-", "xoxp-pome-"],
};
const githubSpec: ProviderTokenSpec = {
  provider: "github",
  prefixes: ["github_pat_pome_", "ghp_pome_"],
};

// The frozen wire construction the twins + cloud already mint today:
// <prefix><base64url(sid)>_<sig22> / <prefix><base64url(sid)>_<exp>_<sig22>
// where sig = hmac-sha256(secret, "<provider>:<sid>[:<exp>]") b64url [0,22).
function legacyMint(prefix: string, provider: string, sid: string, secret: string, exp?: number) {
  const encoded = Buffer.from(sid, "utf8").toString("base64url");
  const payload = exp === undefined ? `${provider}:${sid}` : `${provider}:${sid}:${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
  return exp === undefined ? `${prefix}${encoded}_${sig}` : `${prefix}${encoded}_${exp}_${sig}`;
}

describe("mintProviderToken", () => {
  it("emits the frozen legacy (no-exp) wire shape byte-for-byte", () => {
    const sid = "session-1";
    expect(mintProviderToken(slackSpec, { sid, secret: SECRET })).toBe(
      legacyMint("xoxb-pome-", "slack", sid, SECRET)
    );
  });

  it("emits the frozen exp wire shape byte-for-byte", () => {
    const sid = "session-1";
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(mintProviderToken(slackSpec, { sid, secret: SECRET, exp })).toBe(
      legacyMint("xoxb-pome-", "slack", sid, SECRET, exp)
    );
  });

  it("mints with an alternate declared prefix", () => {
    const token = mintProviderToken(slackSpec, { sid: "s", secret: SECRET, prefix: "xoxp-pome-" });
    expect(token.startsWith("xoxp-pome-")).toBe(true);
    expect(verifyProviderToken(slackSpec, token, SECRET)).toBe("s");
  });

  it("rejects a prefix the spec does not declare", () => {
    expect(() =>
      mintProviderToken(slackSpec, { sid: "s", secret: SECRET, prefix: "xoxa-pome-" })
    ).toThrow(/prefix/);
  });
});

describe("verifyProviderToken", () => {
  it("round-trips a minted legacy token", () => {
    const token = mintProviderToken(githubSpec, { sid: "sid-a", secret: SECRET });
    expect(verifyProviderToken(githubSpec, token, SECRET)).toBe("sid-a");
  });

  it("round-trips a minted exp token that has not expired", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = mintProviderToken(githubSpec, { sid: "sid-a", secret: SECRET, exp });
    expect(verifyProviderToken(githubSpec, token, SECRET)).toBe("sid-a");
  });

  it("rejects an expired exp token", () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = mintProviderToken(githubSpec, { sid: "sid-a", secret: SECRET, exp });
    expect(verifyProviderToken(githubSpec, token, SECRET)).toBeUndefined();
  });

  it("REGRESSION (F-712 appendix): a sid whose base64url encoding contains '_' round-trips", () => {
    // '?' (0x3F) + '>' (0x3E) produce a 6-bit group of 63 → '_' in base64url.
    const sid = "?>?";
    expect(Buffer.from(sid, "utf8").toString("base64url")).toContain("_");
    const legacy = mintProviderToken(slackSpec, { sid, secret: SECRET });
    expect(verifyProviderToken(slackSpec, legacy, SECRET)).toBe(sid);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const withExp = mintProviderToken(slackSpec, { sid, secret: SECRET, exp });
    expect(verifyProviderToken(slackSpec, withExp, SECRET)).toBe(sid);
  });

  it("REGRESSION: a sid whose encoding ends in an all-digit segment is not mis-parsed as exp", () => {
    // Search for a sid whose base64url encoding ends "_<digits>" — the
    // ambiguous shape where a naive parse would strip the digits as an exp
    // segment. HMAC disambiguation must recover the full sid.
    // "ab?Ӎ" → utf8 bytes 61 62 3F D3 8D → base64url "YWI_040".
    const sid = "ab?Ӎ";
    expect(Buffer.from(sid, "utf8").toString("base64url")).toMatch(/_\d+$/);
    const token = mintProviderToken(slackSpec, { sid, secret: SECRET });
    expect(verifyProviderToken(slackSpec, token, SECRET)).toBe(sid);
  });

  it("rejects a tampered signature", () => {
    const token = mintProviderToken(slackSpec, { sid: "sid-a", secret: SECRET });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyProviderToken(slackSpec, tampered, SECRET)).toBeUndefined();
  });

  it("rejects a token minted for a different provider domain", () => {
    // Same secret, same sid — but the HMAC covers "<provider>:", so a slack
    // token re-prefixed as github must not verify.
    const sid = "sid-a";
    const slackToken = mintProviderToken(slackSpec, { sid, secret: SECRET });
    const rePrefixed = `ghp_pome_${slackToken.slice("xoxb-pome-".length)}`;
    expect(verifyProviderToken(githubSpec, rePrefixed, SECRET)).toBeUndefined();
  });

  it("rejects tokens with an undeclared prefix and non-token strings", () => {
    expect(verifyProviderToken(slackSpec, "xoxa-pome-abc_def", SECRET)).toBeUndefined();
    expect(verifyProviderToken(slackSpec, "not-a-token", SECRET)).toBeUndefined();
    expect(verifyProviderToken(slackSpec, "xoxb-pome-", SECRET)).toBeUndefined();
    expect(verifyProviderToken(slackSpec, "xoxb-pome-nounderscore", SECRET)).toBeUndefined();
  });

  it("accepts tokens minted by the pre-F-681 twin code (wire compat)", () => {
    // Byte-identical to twin-slack's signSlackProviderToken / twin-github's
    // signProvider — cloud-minted tokens in flight must keep verifying.
    const sid = "compat-sid";
    expect(
      verifyProviderToken(slackSpec, legacyMint("xoxp-pome-", "slack", sid, SECRET), SECRET)
    ).toBe(sid);
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(
      verifyProviderToken(
        githubSpec,
        legacyMint("github_pat_pome_", "github", sid, SECRET, exp),
        SECRET
      )
    ).toBe(sid);
  });
});
