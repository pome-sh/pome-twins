#!/usr/bin/env node
/**
 * Offline regression coverage for scripts/ci/assert-repo-policy.sh (F-696).
 * Feeds fixture classic protection + rulesets JSON (no live GitHub API).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/assert-repo-policy.sh");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function baseProtection(overrides = {}) {
  return {
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_status_checks: {
      strict: true,
      contexts: ["typecheck-test", "gitleaks + trufflehog", "dependency review"],
    },
    ...overrides,
  };
}

function baseRulesets(overrides = {}) {
  const ruleset = {
    id: 18797095,
    name: "main founder-bypass",
    enforcement: "active",
    target: "branch",
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    bypass_actors: [
      { actor_id: 16601595, actor_type: "Team", bypass_mode: "always" },
    ],
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: "typecheck-test" },
            { context: "gitleaks + trufflehog" },
            { context: "dependency review" },
          ],
        },
      },
      { type: "non_fast_forward" },
    ],
    ...overrides,
  };
  return [ruleset];
}

function runAssert(protection, rulesets = baseRulesets()) {
  const dir = mkdtempSync(join(tmpdir(), "assert-policy-"));
  const jsonPath = join(dir, "protection.json");
  const rulesetsPath = join(dir, "rulesets.json");
  writeFileSync(jsonPath, JSON.stringify(protection));
  writeFileSync(rulesetsPath, JSON.stringify(rulesets));
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "pome-sh/pome-twins",
      POLICY_JSON: jsonPath,
      RULESETS_JSON: rulesetsPath,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

function main() {
  {
    const r = runAssert(baseProtection());
    assert(r.status === 0, `expected ok fixture to pass: ${r.stderr}\n${r.stdout}`);
    assert(r.stdout.includes("ok:"), r.stdout);
  }

  {
    const r = runAssert(
      baseProtection({
        required_status_checks: {
          strict: false,
          contexts: ["typecheck-test", "gitleaks + trufflehog", "dependency review"],
        },
      }),
    );
    assert(r.status === 1, "strict:false must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("strict must be true"), r.stderr);
  }

  {
    const r = runAssert(
      baseProtection({
        allow_force_pushes: { enabled: true },
      }),
    );
    assert(r.status === 1, "force-push enabled must fail");
  }

  {
    const r = runAssert(
      baseProtection({
        allow_deletions: { enabled: true },
      }),
    );
    assert(r.status === 1, "branch deletion enabled must fail");
  }

  {
    const r = runAssert(
      baseProtection({
        required_status_checks: {
          strict: true,
          contexts: ["typecheck-test"],
        },
      }),
    );
    assert(r.status === 1, "missing required contexts must fail");
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("gitleaks + trufflehog"), out);
    assert(out.includes("dependency review"), out);
  }

  {
    // GitHub may return contexts: [] while listing required checks under checks[].
    const r = runAssert(
      baseProtection({
        required_status_checks: {
          strict: true,
          contexts: [],
          checks: [
            { context: "typecheck-test", app_id: 15368 },
            { context: "gitleaks + trufflehog", app_id: 15368 },
            { context: "dependency review", app_id: 15368 },
          ],
        },
      }),
    );
    assert(
      r.status === 0,
      `empty contexts with populated checks must pass: ${r.stderr}\n${r.stdout}`,
    );
  }

  {
    const p = baseProtection();
    delete p.allow_force_pushes;
    const r = runAssert(p);
    assert(r.status === 1, "missing allow_force_pushes must fail closed");
  }

  {
    const r = runAssert(baseProtection(), []);
    assert(r.status === 1, "missing founder ruleset must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("main founder-bypass"), r.stderr);
  }

  {
    const r = runAssert(
      baseProtection(),
      baseRulesets({
        conditions: {
          ref_name: {
            include: ["refs/heads/release/*"],
            exclude: [],
          },
        },
      }),
    );
    assert(r.status === 1, "ruleset scoped away from main must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("must target branch main"), r.stderr);
  }

  {
    const r = runAssert(
      baseProtection(),
      baseRulesets({
        target: "tag",
      }),
    );
    assert(r.status === 1, "non-branch ruleset target must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("must target branch main"), r.stderr);
  }

  {
    const r = runAssert(
      baseProtection(),
      baseRulesets({
        bypass_actors: [],
      }),
    );
    assert(r.status === 1, "ruleset without founder bypass must fail");
  }

  {
    const r = runAssert(
      baseProtection(),
      baseRulesets({
        rules: [
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 0,
              required_review_thread_resolution: true,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "typecheck-test" },
                { context: "gitleaks + trufflehog" },
                { context: "dependency review" },
              ],
            },
          },
        ],
      }),
    );
    assert(r.status === 1, "zero approving reviews on ruleset must fail");
  }

  {
    const r = runAssert(
      baseProtection(),
      baseRulesets({
        rules: [
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              required_review_thread_resolution: false,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "typecheck-test" },
                { context: "gitleaks + trufflehog" },
                { context: "dependency review" },
              ],
            },
          },
        ],
      }),
    );
    assert(r.status === 1, "disabled conversation resolution on ruleset must fail");
  }

  {
    const y = readFileSync(join(ROOT, ".github/workflows/repo-policy.yml"), "utf8");
    assert(!/administration:\s*read/.test(y), "GITHUB_TOKEN cannot use administration scope");
    assert(
      /REPO_POLICY_TOKEN/.test(y),
      "repo-policy must document/use REPO_POLICY_TOKEN for live asserts",
    );
    assert(
      /assert-repo-policy\.test\.mjs/.test(y),
      "repo-policy must run offline validator tests",
    );
    const liveStep = y.match(
      /- name: Assert live branch protection([\s\S]*?)\n\s+run:\s*\|/,
    );
    assert(liveStep, "repo-policy must contain the live protection step");
    assert(
      /if:\s*github\.event_name != 'pull_request'/.test(liveStep[1]),
      "live protection step must never receive REPO_POLICY_TOKEN on PRs",
    );
  }

  console.log("✅ assert-repo-policy regression tests passed");
}

main();
