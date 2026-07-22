# pome-intake — coach Skill 0

Intake a Claude managed agent for testing on Pome: collect the clone scope, register it
via `intake_clone_scope`, report per-server twin coverage. The skill itself is
[`SKILL.md`](./SKILL.md).

## Layout

One authored source per skill — this directory. Nothing is generated from it; what you
see is what ships.

```
pome-intake/
├── SKILL.md      # the skill (frontmatter + instructions, kept short)
└── README.md     # this file
```

## Install

Part of the coach set — install the whole set with one command (see
[`skills/README.md`](../README.md)):

```bash
npx skills add pome-sh/digital-twins
```

Requires the Pome control MCP connection (`claude mcp add --transport http pome
https://mcp.pome.sh/mcp`) so the `mcp__pome__*` tools resolve.

## Test evidence

The fixture matrix (fully-covered / partially-covered / zero-coverage agent YAMLs) and
the kept e2e transcripts from running it live are historical evidence and stay in the
pome-cloud repo (`apps/docs/docs/skills/pome-intake/{fixtures,e2e}/`). Every report
carries the standing D9 (memory snapshot-clone, never attach) and D10 (closed-book:
`web_search`/`web_fetch` disabled, F-770) warnings.
