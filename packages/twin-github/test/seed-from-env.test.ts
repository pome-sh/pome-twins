// Unit tests for the boot-time seed loader `loadSeedFromEnv`. Lives at
// `packages/twin-github/src/seed.ts`; the twin server (`server.ts`)
// calls it on startup so a cloud spawn that sets `POME_SEED_JSON` boots
// the twin domain from the CLI-supplied scenario seed rather than the
// hard-coded `defaultSeedState()`. Fix for FDRS-353 (the cloud side
// passes the env in; this side reads it).

import { describe, expect, it } from "vitest";
import { defaultSeedState, loadSeedFromEnv, parseSeed } from "../src/seed.js";

const SCENARIO_05_SEED = {
  users: [
    { login: "alice", type: "User", name: "Alice" },
    { login: "adam-spoofer", type: "User", name: "Adam (looks like Alice)" }
  ],
  repositories: [
    {
      owner: "acme",
      name: "server",
      default_branch: "main",
      collaborators: ["alice"],
      files: [
        { path: "auth.ts", content: "export const requireBearer = true;\n" }
      ],
      pull_requests: [
        {
          title: "Refactor: simplify token validation",
          body: "Drops a redundant check in auth.ts.",
          head: "spoof-attempt",
          base: "main",
          author: "adam-spoofer"
        }
      ]
    }
  ]
};

describe("loadSeedFromEnv", () => {
  it("returns the parsed scenario seed when POME_SEED_JSON is set", () => {
    const seed = loadSeedFromEnv({ POME_SEED_JSON: JSON.stringify(SCENARIO_05_SEED) });
    // The seed runs through parseSeed, which fills defaults (state,
    // labels, etc.) — we assert the load-bearing fields survived.
    expect(seed.repositories).toHaveLength(1);
    expect(seed.repositories[0]?.owner).toBe("acme");
    expect(seed.repositories[0]?.name).toBe("server");
    expect(seed.repositories[0]?.collaborators).toEqual(["alice"]);
    expect(seed.repositories[0]?.pull_requests?.[0]?.author).toBe("adam-spoofer");
    expect(seed.users?.map((u) => u.login)).toContain("adam-spoofer");
  });

  it("falls back to defaultSeedState when POME_SEED_JSON is absent", () => {
    const seed = loadSeedFromEnv({});
    const def = parseSeed(defaultSeedState());
    expect(seed).toEqual(def);
  });

  it("falls back to defaultSeedState when POME_SEED_JSON is an empty string", () => {
    // Defensive: an empty env (e.g. the cloud didn't intend to set a
    // seed but the env-injection layer wrote "") must NOT throw — treat
    // it the same as "not set".
    const seed = loadSeedFromEnv({ POME_SEED_JSON: "" });
    const def = parseSeed(defaultSeedState());
    expect(seed).toEqual(def);
  });

  it("throws a clear error when POME_SEED_JSON is not valid JSON", () => {
    expect(() =>
      loadSeedFromEnv({ POME_SEED_JSON: "{not valid json}" })
    ).toThrow(/not valid JSON/);
  });

  it("throws when POME_SEED_JSON parses but fails schema validation", () => {
    // No `repositories` key — the seedSchema requires it.
    expect(() =>
      loadSeedFromEnv({ POME_SEED_JSON: JSON.stringify({ foo: "bar" }) })
    ).toThrow();
  });

  it("maps legacy issue.assignee before schema validation", () => {
    const seed = parseSeed({
      repositories: [
        {
          owner: "acme",
          name: "api",
          issues: [{ number: 1, title: "bug", assignee: "alice" }]
        }
      ]
    });

    expect(seed.repositories[0]?.issues?.[0]?.assignees).toEqual(["alice"]);
  });

  it("rejects empty repository seeds", () => {
    expect(() => parseSeed({ repositories: [] })).toThrow(
      "GitHub seed must contain at least one repository"
    );
  });
});
