// SPDX-License-Identifier: Apache-2.0
// FDRS-635 — unit tests for the egress floor's allowlist semantics.
//
// The floor is deny-by-default: only twin hosts + LLM provider hosts +
// loopback may be CONNECTed to. The default provider set deliberately
// mirrors `DEFAULT_AGENT_ENV_ALLOWLIST` in agentRunner.ts — a provider the
// runner hands an API key for by default is a provider the floor lets the
// agent dial by default. Everything else goes through the paired valves:
// POME_AGENT_ENV_ALLOWLIST (key) + POME_EGRESS_ALLOW (host).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEgressAllowlist,
  isHostAllowed,
  parseAllowCsv,
  readBlockedEgress,
} from "../../src/capture-server/egress.js";

describe("isHostAllowed", () => {
  it("always allows the loopback family, even with an empty allowlist", () => {
    expect(isHostAllowed("127.0.0.1", [])).toBe(true);
    expect(isHostAllowed("127.1.2.3", [])).toBe(true);
    expect(isHostAllowed("localhost", [])).toBe(true);
    expect(isHostAllowed("LOCALHOST", [])).toBe(true);
    expect(isHostAllowed("::1", [])).toBe(true);
    expect(isHostAllowed("api.localhost", [])).toBe(true);
  });

  it("denies non-loopback hosts when the allowlist is empty", () => {
    expect(isHostAllowed("api.github.com", [])).toBe(false);
    expect(isHostAllowed("128.0.0.1", [])).toBe(false);
    expect(isHostAllowed("127.evil.com", [])).toBe(false);
  });

  it("matches exact entries case-insensitively and ignores trailing dots", () => {
    const patterns = ["api.github.com"];
    expect(isHostAllowed("api.github.com", patterns)).toBe(true);
    expect(isHostAllowed("API.GitHub.COM", patterns)).toBe(true);
    expect(isHostAllowed("api.github.com.", patterns)).toBe(true);
    expect(isHostAllowed("api.github.com.evil.io", patterns)).toBe(false);
    expect(isHostAllowed("xapi.github.com", patterns)).toBe(false);
  });

  it("matches `*.suffix` entries against subdomains but not the apex", () => {
    const patterns = ["*.anthropic.com"];
    expect(isHostAllowed("api.anthropic.com", patterns)).toBe(true);
    expect(isHostAllowed("statsig.anthropic.com", patterns)).toBe(true);
    expect(isHostAllowed("a.b.anthropic.com", patterns)).toBe(true);
    expect(isHostAllowed("anthropic.com", patterns)).toBe(false);
    expect(isHostAllowed("evil-anthropic.com", patterns)).toBe(false);
    expect(isHostAllowed("anthropic.com.evil.io", patterns)).toBe(false);
  });

  it("treats a bare `*` entry as allow-everything", () => {
    expect(isHostAllowed("api.github.com", ["*"])).toBe(true);
  });
});

describe("buildEgressAllowlist", () => {
  it("allows the default LLM providers whose keys the runner forwards by default", () => {
    const patterns = buildEgressAllowlist({});
    expect(isHostAllowed("api.anthropic.com", patterns)).toBe(true);
    expect(isHostAllowed("statsig.anthropic.com", patterns)).toBe(true);
    expect(isHostAllowed("api.openai.com", patterns)).toBe(true);
    expect(isHostAllowed("generativelanguage.googleapis.com", patterns)).toBe(true);
    expect(isHostAllowed("openrouter.ai", patterns)).toBe(true);
    expect(isHostAllowed("ai-gateway.vercel.sh", patterns)).toBe(true);
  });

  it("does not allow production API hosts or unrelated Google surfaces by default", () => {
    const patterns = buildEgressAllowlist({});
    expect(isHostAllowed("api.github.com", patterns)).toBe(false);
    expect(isHostAllowed("api.stripe.com", patterns)).toBe(false);
    expect(isHostAllowed("slack.com", patterns)).toBe(false);
    // *.googleapis.com would be far too broad (storage, GCS, …).
    expect(isHostAllowed("storage.googleapis.com", patterns)).toBe(false);
  });

  it("derives extra hosts from well-known BASE_URL env vars", () => {
    const patterns = buildEgressAllowlist({
      ANTHROPIC_BASE_URL: "https://llm-proxy.corp.example:8443/v1",
      OPENAI_BASE_URL: "http://my-ollama.lan:11434/v1",
    });
    expect(isHostAllowed("llm-proxy.corp.example", patterns)).toBe(true);
    expect(isHostAllowed("my-ollama.lan", patterns)).toBe(true);
  });

  it("ignores malformed BASE_URL env values instead of throwing", () => {
    const patterns = buildEgressAllowlist({ ANTHROPIC_BASE_URL: "not a url" });
    expect(isHostAllowed("api.anthropic.com", patterns)).toBe(true);
  });

  it("honors the POME_EGRESS_ALLOW valve (CSV of extra patterns)", () => {
    const patterns = buildEgressAllowlist({
      POME_EGRESS_ALLOW: "bedrock-runtime.us-east-1.amazonaws.com, *.mistral.ai",
    });
    expect(isHostAllowed("bedrock-runtime.us-east-1.amazonaws.com", patterns)).toBe(true);
    expect(isHostAllowed("api.mistral.ai", patterns)).toBe(true);
    expect(isHostAllowed("s3.us-east-1.amazonaws.com", patterns)).toBe(false);
  });

  it("includes twin URL hosts when provided", () => {
    const patterns = buildEgressAllowlist({}, { twinUrls: ["https://twins.pome.sh/s/abc"] });
    expect(isHostAllowed("twins.pome.sh", patterns)).toBe(true);
  });
});

describe("parseAllowCsv", () => {
  it("splits, trims, and drops empty entries", () => {
    expect(parseAllowCsv(" a.example ,,*.b.example , ")).toEqual(["a.example", "*.b.example"]);
    expect(parseAllowCsv(undefined)).toEqual([]);
    expect(parseAllowCsv("")).toEqual([]);
  });
});

describe("readBlockedEgress", () => {
  it("aggregates refused rows per host:port, most-hit first, skipping junk lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-egress-"));
    const path = join(dir, "egress.jsonl");
    const rows = [
      { ts: "2026-07-02T00:00:00Z", kind: "EgressRefusedEvent", host: "api.github.com", port: 443 },
      { ts: "2026-07-02T00:00:01Z", kind: "EgressRefusedEvent", host: "api.github.com", port: 443 },
      { ts: "2026-07-02T00:00:02Z", kind: "EgressRefusedEvent", host: "example.com", port: 443 },
    ];
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot-json\n");

    const blocked = await readBlockedEgress(path);
    expect(blocked).toEqual([
      { host: "api.github.com", port: 443, count: 2 },
      { host: "example.com", port: 443, count: 1 },
    ]);
  });

  it("returns [] when the file is missing or empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-egress-"));
    expect(await readBlockedEgress(join(dir, "missing.jsonl"))).toEqual([]);
    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "");
    expect(await readBlockedEgress(empty)).toEqual([]);
  });
});
