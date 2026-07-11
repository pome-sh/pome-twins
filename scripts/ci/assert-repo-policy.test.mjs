#!/usr/bin/env node
/**
 * Offline regression coverage for scripts/ci/assert-repo-policy.sh (F-696).
 * Feeds fixture protection JSON via POLICY_JSON (no live GitHub API).
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
    required_pull_request_reviews: { required_approving_review_count: 1 },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
    required_status_checks: {
      strict: true,
      contexts: ["typecheck-test", "gitleaks + trufflehog", "dependency review"],
    },
    ...overrides,
  };
}

function runAssert(protection) {
  const dir = mkdtempSync(join(tmpdir(), "assert-policy-"));
  const jsonPath = join(dir, "protection.json");
  writeFileSync(jsonPath, JSON.stringify(protection));
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "pome-sh/pome-twins",
      POLICY_JSON: jsonPath,
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
    const p = baseProtection();
    delete p.allow_force_pushes;
    const r = runAssert(p);
    assert(r.status === 1, "missing allow_force_pushes must fail closed");
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
  }

  console.log("✅ assert-repo-policy regression tests passed");
}

main();
