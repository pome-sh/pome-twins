// SPDX-License-Identifier: Apache-2.0
/**
 * Static index of public Mintlify pages on docs.pome.sh — avoids scraping HTML.
 * Each topic maps to a bundled markdown/mdx file in this package so `pome docs`
 * can render the same narrative in the terminal (see docs-render.ts).
 * Update when `docs.json` navigation or on-disk doc paths change.
 *
 * ## Why not fetch Mintlify?
 *
 * docs.pome.sh is a compiled site (MDX → React/HTML). Pulling HTML and "unstaging"
 * it for ANSI terminals would couple the CLI to Mintlify's DOM, break on redesigns,
 * and still miss MDX-only constructs. Shipping the authored source next to the CLI
 * keeps terminal + web aligned by convention: edit the page here, publish to Mintlify
 * from the same repo.
 */
export interface DocsTopic {
  id: string;
  title: string;
  /** Path on the docs site, e.g. /getting-started */
  path: string;
  /** Source file relative to the package root (published with the tarball). */
  sourceFile: string;
  keywords: string[];
}

export const DOCS_TOPICS: DocsTopic[] = [
  {
    id: "pome",
    title: "Pome",
    path: "/introduction",
    sourceFile: "introduction.mdx",
    keywords: ["overview", "what is pome", "platform", "agents"],
  },
  {
    id: "getting-started",
    title: "Quickstart",
    path: "/getting-started",
    sourceFile: "getting-started.mdx",
    keywords: ["install", "quickstart", "setup", "begin"],
  },
  {
    id: "how-pome-works",
    title: "How Pome works",
    path: "/docs/how-pome-works",
    sourceFile: "docs/how-pome-works.mdx",
    keywords: ["twins", "scenarios", "runs", "scoring", "artifacts", "loop"],
  },
  {
    id: "skills-setup",
    title: "/setup",
    path: "/docs/skills/setup",
    sourceFile: "docs/skills/setup.mdx",
    keywords: ["pome-setup", "setup", "/setup", "register", "wire"],
  },
  {
    id: "skills-test",
    title: "/test-with-pome",
    path: "/docs/skills/test-with-pome",
    sourceFile: "docs/skills/test-with-pome.mdx",
    keywords: ["pome-test", "test-with-pome", "/test-with-pome", "run scenarios", "eval"],
  },
  {
    id: "dashboard",
    title: "Pome Dashboard",
    path: "/docs/dashboard",
    sourceFile: "docs/dashboard.mdx",
    keywords: ["runs", "agents", "clones", "judge", "web"],
  },
  {
    id: "twins",
    title: "Twins overview",
    path: "/docs/twins/index",
    sourceFile: "docs/twins/index.mdx",
    keywords: ["sandbox", "digital twin", "hosted"],
  },
  {
    id: "github",
    title: "GitHub twin",
    path: "/docs/twins/github",
    sourceFile: "docs/twins/github.mdx",
    keywords: ["git", "repo", "issues", "mcp", "scenarios"],
  },
  {
    id: "stripe",
    title: "Stripe twin",
    path: "/docs/twins/stripe",
    sourceFile: "docs/twins/stripe.mdx",
    keywords: ["payments", "x402", "refund", "payment intent", "stripe"],
  },
  {
    id: "slack",
    title: "Slack twin",
    path: "/docs/twins/slack",
    sourceFile: "docs/twins/slack.mdx",
    keywords: ["messaging", "channels", "workspace", "slack", "exfiltration"],
  },
  {
    id: "cli",
    title: "Command Line Interface",
    path: "/docs/cli",
    sourceFile: "docs/cli/index.mdx",
    keywords: ["commands", "flags", "pome run", "reference"],
  },
  {
    id: "cli-run",
    title: "pome run",
    path: "/docs/cli/run",
    sourceFile: "docs/cli/run.mdx",
    keywords: ["run", "scenario", "agent", "flags", "artifacts"],
  },
  {
    id: "cli-session",
    title: "pome session",
    path: "/docs/cli/session",
    sourceFile: "docs/cli/session.mdx",
    keywords: ["session", "hosted", "sandbox", "twin"],
  },
  {
    id: "cli-scenarios",
    title: "pome scenarios",
    path: "/docs/cli/scenarios",
    sourceFile: "docs/cli/scenarios.mdx",
    keywords: ["scenarios", "catalog", "copy", "library", "twin"],
  },
  {
    id: "cli-compile-seeds",
    title: "pome compile-seeds",
    path: "/docs/cli/compile-seeds",
    sourceFile: "docs/cli/compile-seeds.mdx",
    keywords: ["compile-seeds", "seed", "sidecar", "compiler", "anthropic"],
  },
  {
    id: "cli-inspect",
    title: "pome inspect",
    path: "/docs/cli/inspect",
    sourceFile: "docs/cli/inspect.mdx",
    keywords: ["inspect", "score", "trace", "artifacts", "verdicts"],
  },
  {
    id: "cli-init",
    title: "pome init",
    path: "/docs/cli/init",
    sourceFile: "docs/cli/init.mdx",
    keywords: ["init", "scaffold", "pome.config.json", "project"],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    path: "/docs/troubleshooting",
    sourceFile: "docs/troubleshooting.md",
    keywords: ["errors", "help", "fix", "debug"],
  },
  {
    id: "changelog",
    title: "Changelog",
    path: "/changelog",
    sourceFile: "changelog.mdx",
    keywords: ["release", "version", "news"],
  },
];
