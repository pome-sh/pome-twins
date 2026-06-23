import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSeedState, loadSeedFromEnv, parseSeed } from "../src/seed.js";

const ENV_KEY = "POME_SEED_JSON";

describe("loadSeedFromEnv", () => {
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  it("returns defaultSeedState when env is unset", () => {
    delete process.env[ENV_KEY];
    const seed = loadSeedFromEnv();
    expect(seed.team?.id).toBe("T_POME");
    expect(seed.channels?.length).toBe(2);
  });

  it("accepts a flat schema", () => {
    process.env[ENV_KEY] = JSON.stringify({
      team: { name: "Override" },
      users: [{ name: "carol" }],
      channels: [{ name: "alpha" }],
    });
    const seed = loadSeedFromEnv();
    expect(seed.team?.name).toBe("Override");
    expect(seed.users?.[0]!.name).toBe("carol");
    expect(seed.channels?.[0]!.name).toBe("alpha");
  });

  it("unwraps the cloud-side {slack:{seed:…}} envelope", () => {
    process.env[ENV_KEY] = JSON.stringify({
      slack: { seed: { team: { name: "Envelope" }, channels: [{ name: "beta" }] } },
    });
    const seed = loadSeedFromEnv();
    expect(seed.team?.name).toBe("Envelope");
    expect(seed.channels?.[0]!.name).toBe("beta");
  });

  it("throws on malformed JSON", () => {
    process.env[ENV_KEY] = "not-json";
    expect(() => loadSeedFromEnv()).toThrow(/not valid JSON/);
  });

  it("throws on schema-invalid seed (bad channel name)", () => {
    process.env[ENV_KEY] = JSON.stringify({ channels: [{ name: "UPPERCASE" }] });
    expect(() => loadSeedFromEnv()).toThrow();
  });

  it("parseSeed normalizes minimum input", () => {
    const parsed = parseSeed({});
    expect(parsed.team?.name).toBe("Pome Twin Workspace");
    expect(parsed.users).toEqual([]);
    expect(parsed.channels).toEqual([]);
  });

  it("parseSeed accepts default team via prefault", () => {
    const parsed = parseSeed({ users: [{ name: "x" }] });
    expect(parsed.team?.name).toBe("Pome Twin Workspace");
    expect(parsed.users?.[0]!.name).toBe("x");
  });
});

describe("defaultSeedState", () => {
  it("includes pome-agent + alice + bob + #general + #random", () => {
    const seed = defaultSeedState();
    const userNames = seed.users!.map((u) => u.name).sort();
    expect(userNames).toEqual(["alice", "bob", "pome-agent"]);
    const channelNames = seed.channels!.map((c) => c.name).sort();
    expect(channelNames).toEqual(["general", "random"]);
  });
});
