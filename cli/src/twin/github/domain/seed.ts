// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

// Schema-inferred shape (with zod defaults applied). The hand-written
// `SeedState` in `../types.js` is wider — used by code that consumes
// loosely-validated input — so we don't import it here. The functions
// below return the post-parse / post-default narrow type so consumers
// like `parseScenario.ts` line up with the union in `scenarioSchema.ts`.
type ParsedSeedState = z.infer<typeof seedStateSchema>;

export const seedStateSchema = z.object({
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        type: z.enum(["User", "Organization"]).default("User"),
        name: z.string().default("")
      })
    )
    .optional(),
  repositories: z
    .array(
      z.object({
        owner: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        default_branch: z.string().min(1).optional(),
        labels: z
          .array(
            z.object({
              name: z.string().min(1),
              color: z.string().default("ededed"),
              description: z.string().default("")
            })
          )
          .default([]),
        collaborators: z.array(z.string().min(1)).default([]),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
              branch: z.string().optional()
            })
          )
          .optional(),
        issues: z
          .array(
            z.object({
              number: z.number().int().positive(),
              title: z.string().min(1),
              body: z.string().default(""),
              state: z.enum(["open", "closed"]).default("open"),
              labels: z.array(z.string().min(1)).default([]),
              assignee: z.string().nullable().default(null)
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
              // Reviews seeded on this PR. State mirrors GitHub's review state
              // enum; author must exist in users or collaborators.
              reviews: z
                .array(
                  z.object({
                    author: z.string().min(1),
                    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]).default("APPROVED"),
                    body: z.string().default("")
                  })
                )
                .default([]),
              // Commit statuses on the PR head SHA, wired into commit_statuses
              // so get_pull_request_status and merge_pull_request see them.
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
          .optional()
      })
    )
    .min(1)
});

export function parseSeedState(input: unknown): ParsedSeedState {
  return seedStateSchema.parse(input);
}

export function defaultSeedState(): ParsedSeedState {
  // Run the literal through `parse` so zod fills in defaults (state,
  // pull_requests, etc.) — keeps this fixture aligned with the schema
  // without hand-listing every required-after-default field.
  return seedStateSchema.parse({
    repositories: [
      {
        owner: "acme",
        name: "api",
        labels: [
          { name: "bug", color: "d73a4a", description: "Something is not working" },
          { name: "feature", color: "a2eeef", description: "New feature or request" },
          { name: "question", color: "d876e3", description: "More information needed" }
        ],
        collaborators: ["alice", "bob"],
        issues: [
          {
            number: 1,
            title: "500 error on POST /orders after deploy",
            body: "Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.",
            labels: [],
            assignee: null
          }
        ]
      }
    ]
  });
}
