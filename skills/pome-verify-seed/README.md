# pome-verify-seed — coach Skill 2

Verify a task's seed is a fair exam before any run: `verify_seed` +
guard-aware triage, state-diff review, `evaluate_criteria` dry-run, and an
opt-in live probe session. The skill itself is [`SKILL.md`](./SKILL.md); the
expanded checklist is
[`references/seed-fidelity-checklist.md`](./references/seed-fidelity-checklist.md).

## Layout

One authored source per skill — this directory. Nothing is generated from it.

```
pome-verify-seed/
├── SKILL.md      # the skill (frontmatter + instructions, <100 lines)
├── references/   # seed-fidelity-checklist.md — loaded on demand, not inlined
└── README.md     # this file
```

## Install

Part of the coach set — install the whole set with one command (see
[`skills/README.md`](../README.md)); `references/` ships with the skill so the
one-level-deep link resolves:

```bash
npx skills add pome-sh/digital-twins
```

Requires the Pome control MCP connection (`claude mcp add --transport http pome
https://mcp.pome.sh/mcp`) so the `mcp__pome__*` tools resolve.

## Test evidence

The fixture matrix (healthy-blocking / broken-all-pass / no-seed-state task
markdowns) and the kept e2e transcripts are historical evidence and stay in the
pome-cloud repo (`apps/docs/docs/skills/pome-verify-seed/{fixtures,e2e}/`). The
false-`BROKEN` behavior the first fixture exercises is the cold-start field
report §7 finding ("`verify_seed` cries wolf on every blocking task") —
the skill triages by criterion intent instead of trusting the verdict.
