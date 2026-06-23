import { describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain.js";

describe("SQLite performance smoke checks", () => {
  it("keeps hot-path search, listing, and export bounded on larger seeded repos", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    const files = Array.from({ length: 600 }, (_, index) => ({
      path: `src/generated/file-${index}.ts`,
      content: `export const marker_${index} = "needle";\n`
    }));
    const issues = Array.from({ length: 600 }, (_, index) => ({
      number: index + 1,
      title: `Generated issue ${index}`,
      body: index % 2 === 0 ? "needle auth bug" : "orders feature",
      labels: [index % 2 === 0 ? "bug" : "feature"]
    }));

    domain.seed({
      users: [
        { login: "acme", type: "Organization", name: "Acme" },
        { login: "pome-agent", type: "User", name: "Pome Agent" }
      ],
      repositories: [
        {
          owner: "acme",
          name: "big",
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "feature", color: "a2eeef" }
          ],
          files,
          issues
        }
      ]
    });

    const started = Date.now();
    expect(domain.searchCode({ owner: "acme", repo: "big", q: "needle", per_page: 10 }).total_count).toBe(600);
    expect(domain.searchIssues({ q: "needle", per_page: 10 }).total_count).toBe(300);
    expect(domain.listIssues({ owner: "acme", repo: "big", labels: "bug", per_page: 10 })).toHaveLength(10);
    expect(domain.exportState().repositories[0].issues).toHaveLength(600);
    // Keep this as a smoke bound, not a micro-benchmark: workspace-parallel CI
    // can starve the SQLite-heavy export path on developer machines.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
