import { describe, expect, it } from "vitest";
import { normalizeLegacyGitHubSeed, parseGitHubSeedState } from "../../src/scenario/githubSeedCompat.js";

describe("githubSeedCompat", () => {
  it("maps legacy issue assignee to assignees before seedSchema parse", () => {
    const normalized = normalizeLegacyGitHubSeed({
      repositories: [
        {
          owner: "acme",
          name: "api",
          issues: [{ number: 1, title: "bug", assignee: "alice" }],
        },
      ],
    });

    expect(normalized).toMatchObject({
      repositories: [{ issues: [{ assignees: ["alice"] }] }],
    });
    expect(
      parseGitHubSeedState({
        repositories: [
          {
            owner: "acme",
            name: "api",
            issues: [{ number: 1, title: "bug", assignee: "alice" }],
          },
        ],
      }),
    ).toMatchObject({
      repositories: [{ issues: [{ assignees: ["alice"] }] }],
    });
  });

  it("leaves assignees unchanged when already present", () => {
    expect(
      parseGitHubSeedState({
        repositories: [
          {
            owner: "acme",
            name: "api",
            issues: [{ number: 1, title: "bug", assignees: ["bob"] }],
          },
        ],
      }),
    ).toMatchObject({
      repositories: [{ issues: [{ assignees: ["bob"] }] }],
    });
  });

  it("rejects empty repository seeds before booting a twin", () => {
    expect(() => parseGitHubSeedState({ repositories: [] })).toThrow(
      "GitHub seed must contain at least one repository",
    );
  });
});
