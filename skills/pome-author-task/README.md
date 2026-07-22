# pome-author-task — coach Skill 1

Author a graded Pome task for a builder's agent and save it to their team
catalog: library-first adaptation, a fear-driven interview, then a
validate → dry-run → save loop. The skill itself is [`SKILL.md`](./SKILL.md); the
task grammar it links to is
[`references/task-format.md`](./references/task-format.md).

Runs downstream of Skill 0 ([`pome-intake`](../pome-intake/README.md)): intake
registers the examinee clone and reports twin coverage; this skill writes the
tests that exercise it.

## Layout

One authored source per skill — this directory. Nothing is generated from it;
what you see is what ships.

```
pome-author-task/
├── SKILL.md                  # the skill (frontmatter + instructions, <100 lines)
├── references/task-format.md # the task-markdown grammar (F-774), linked one level deep
└── README.md                 # this file
```

## Install

Part of the coach set — install the whole set with one command (see
[`skills/README.md`](../README.md)); `references/` ships with the skill so the
one-level-deep link resolves:

```bash
npx skills add pome-sh/digital-twins
```

Requires the Pome control MCP connection (`claude mcp add --transport http pome
https://mcp.pome.sh/mcp`) so the `list_tasks` / `validate_task` /
`verify_seed` / `evaluate_criteria` / `save_task` tools resolve.

## The authoring loop

1. **Library-first** (the Skill 3 reuse module, F-781) — `list_tasks`,
   adapt the nearest match: rebuild the draft from the coach view (there is no
   get-task tool; a `has_seed_state` task needs a fresh seed — the view
   never returns one), check the intended name for collisions, save-as-new
   (`save_task` upserts on name — never overwrite someone else's).
2. **Interview** — fear surfaces: worst fear / prompt-injection / wrong-channel /
   severity misjudgment; only the ones the covered twins can exercise.
3. **Draft** — task markdown, `[code]` / `[model]` criteria; grammar lives in
   the reference, not inlined.
4. **Validate + dry-run** — `validate_task` → `verify_seed` → `evaluate_criteria`,
   loop until validation is clean and no criterion is `unmatched` or
   pre-satisfied.
5. **Save** — `save_task`, confirm the new name in `list_tasks`.

## Test evidence

The kept e2e transcripts (the A1 live authoring check and the A2 library-reuse
check, F-781) are historical evidence and stay in the pome-cloud repo
(`apps/docs/docs/skills/`).
