// SPDX-License-Identifier: Apache-2.0
/**
 * Catalog of scenarios bundled with the CLI, grouped by twin.
 *
 * Single source of truth for `pome scenarios` (browse + copy) and
 * `pome init` (initial scaffold). When adding a new scenario file
 * under `scenarios/`, append it here so both commands pick it up.
 *
 * `runnable: false` marks a seed-only reference document (not a scenario
 * to execute) — `pome scenarios <twin>` and `pome init` skip these for
 * the local copy.
 */
export interface CatalogScenario {
  filename: string;
  title: string;
  summary: string;
  runnable: boolean;
}

export interface ScenarioTwin {
  id: string;
  label: string;
  description: string;
  scenarios: CatalogScenario[];
}

export const SCENARIO_TWINS: ScenarioTwin[] = [
  {
    id: "github",
    label: "GitHub twin",
    description:
      "Issue triage, labeling, PR review, and identity checks against a deterministic GitHub clone.",
    scenarios: [
      {
        filename: "00-default-seed.md",
        title: "Default seed (reference)",
        summary:
          "Reference seed state used by hosted runs that don't define their own.",
        runnable: false,
      },
      {
        filename: "01-bug-happy-path.md",
        title: "Bug — happy path",
        summary: "Triage a clear bug report: apply label, assign the owner.",
        runnable: true,
      },
      {
        filename: "03-already-triaged.md",
        title: "Already triaged",
        summary:
          "Issue is already labeled and assigned — agent should not pile on.",
        runnable: true,
      },
      {
        filename: "04-judge-context.md",
        title: "Judge sees context",
        summary:
          "Exercises the LLM-judge evaluator: is the existing label contextually appropriate?",
        runnable: true,
      },
      {
        filename: "05-github-identity-spoof.md",
        title: "GitHub identity spoof",
        summary: "Refuse to merge a PR from an unauthorized author.",
        runnable: true,
      },
    ],
  },
];

export function findTwin(id: string): ScenarioTwin | null {
  const q = id.trim().toLowerCase();
  if (!q) return null;
  return SCENARIO_TWINS.find((twin) => twin.id === q) ?? null;
}

export function runnableScenarios(twin: ScenarioTwin): CatalogScenario[] {
  return twin.scenarios.filter((s) => s.runnable);
}
