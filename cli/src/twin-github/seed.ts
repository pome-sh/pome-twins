// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { GitHubStateSeed } from "./types.js";

export const seedSchema = z.object({
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        type: z.enum(["User", "Organization"]).default("User"),
        name: z.string().default("")
      })
    )
    .default([]),
  repositories: z.array(
    z.object({
      owner: z.string().min(1),
      name: z.string().min(1),
      description: z.string().default(""),
      private: z.boolean().default(false),
      default_branch: z.string().min(1).default("main"),
      collaborators: z.array(z.string().min(1)).default([]),
      labels: z
        .array(
          z.object({
            name: z.string().min(1),
            color: z.string().default("ededed"),
            description: z.string().default("")
          })
        )
        .default([]),
      files: z.array(z.object({ path: z.string().min(1), content: z.string(), branch: z.string().optional() })).default([]),
      issues: z
        .array(
          z.object({
            number: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().default(""),
            state: z.enum(["open", "closed"]).default("open"),
            labels: z.array(z.string().min(1)).default([]),
            assignees: z.array(z.string().min(1)).default([])
          })
        )
        .default([]),
      pull_requests: z
        .array(
          z.object({
            number: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().default(""),
            head: z.string().min(1),
            base: z.string().min(1).default("main"),
            state: z.enum(["open", "closed"]).default("open"),
            author: z.string().min(1).optional(),
            // Reviews seeded on this PR. `state` mirrors GitHub's review
            // state enum; `author` must exist in the user/collaborator set.
            reviews: z
              .array(
                z.object({
                  author: z.string().min(1),
                  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]).default("APPROVED"),
                  body: z.string().default("")
                })
              )
              .default([]),
            // Commit statuses applied to this PR's head SHA. Wired into the
            // commit_statuses table so get_pull_request_status and the merge
            // path see them without needing a separate setup call.
            statuses: z
              .array(
                z.object({
                  context: z.string().min(1).default("ci/build"),
                  state: z.enum(["error", "failure", "pending", "success"]).default("success"),
                  description: z.string().default("")
                })
              )
              .default([])
          })
        )
        .default([])
    })
  )
});

export function parseSeed(input: unknown): GitHubStateSeed {
  return seedSchema.parse(input);
}

export function defaultSeedState(): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "alice", type: "User", name: "Alice" },
      { login: "bob", type: "User", name: "Bob" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        description: "Example API service used by GitHub twin tests.",
        default_branch: "main",
        collaborators: ["alice", "bob", "pome-agent"],
        labels: [
          { name: "bug", color: "d73a4a", description: "Something is not working" },
          { name: "feature", color: "a2eeef", description: "New feature or request" },
          { name: "question", color: "d876e3", description: "More information needed" }
        ],
        files: [
          { path: "README.md", content: "# Acme API\n\nA seeded repository for local GitHub twin tests.\n" },
          { path: "src/index.ts", content: "export function handler() {\n  return 'ok';\n}\n" }
        ],
        issues: [
          {
            number: 1,
            title: "500 error on POST /orders after deploy",
            body: "Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.",
            labels: ["bug"],
            assignees: []
          }
        ]
      }
    ]
  };
}
