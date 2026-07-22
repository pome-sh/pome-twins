# Task format

This is the authoring grammar for Pome task markdown ("scenario" is the
retired historical name for the same document). It is extracted
verbatim from the parser that `validate_task`, `save_task`, and
`run_task` all share: `apps/mcp/src/task/parseTask.ts` +
`apps/mcp/src/task/taskSchema.ts` in pome-cloud, the pinned
source-copy of the CLI parser at pome-twins commit `2ce4f86`. Where this
prose and the parser disagree, the parser wins.

A task is one markdown file. The parser reads it in four steps: pick the
title, split the document into `##` sections, parse the criteria and config,
then resolve the seed. Each step's exact rules follow.

## Title

The title is the first line in the whole document matching:

```
/^#\s+(.+)$/m
```

i.e. a line starting `# ` (one `#`). The captured text is trimmed. If no such
line exists, the task's slug is used as the title. The title may appear
anywhere in the file, but by convention it is line 1.

## Sections

Sections are split on level-2 headings only:

```
/^##\s+(.+)$/gm
```

Heading names are trimmed and lowercased before lookup, so `## Prompt`,
`## PROMPT`, and `##   prompt  ` are all the same section. `###` (or deeper)
headings do NOT start a section — they stay inside the enclosing section's
text. A section's content runs from the end of its heading line to the next
`##` heading (trimmed).

| Heading (case-insensitive) | Alias | Required | Role |
| --- | --- | --- | --- |
| `## Prompt` | `## Task` | yes (non-empty) | The instruction given to the agent under test. |
| `## Success Criteria` | `## Checks` | yes (≥1 criterion line) | Graded criteria; see marker grammar below. |
| `## Setup` | — | no (defaults to `""`) | Human-readable context prose. Ignored at runtime. |
| `## Expected Behavior` | — | no (defaults to `""`) | Evaluator-only description of a good run. Never sent to the agent. |
| `## Config` | — | no (all keys have defaults) | Fenced YAML block; see Config below. |
| `## Seed State` | — | no (defaults per twin) | Fenced JSON block; see Seed State below. |

Unrecognized `##` sections are silently ignored. When both a heading and its
alias are present, the primary name wins (`prompt` over `task`,
`success criteria` over `checks`).

Two parsing gotchas to know:

* The splitter runs on the raw markdown and does not understand code fences.
  A line starting `## ` inside a fenced block still starts a new section —
  never put `## ` at the start of a line inside `## Prompt` prose, seed JSON
  strings, etc.
* A missing `## Prompt` or an empty criteria list fails schema validation
  (`prompt` must be non-empty; `criteria` must have at least 1 entry), so
  `validate_task` rejects the document.

## Success criteria markers

Each criterion is one bullet line in `## Success Criteria`. The exact line
grammar (applied to each line after trimming) is:

```
/^[-*]\s+\[(code|model)(?::([a-z][a-z0-9_-]*))?\]\s+(.+)$/
```

That is: a `-` or `*` bullet, a space, a `[code]` or `[model]` marker
(lowercase only) optionally carrying a twin tag `[code:<twin>]` /
`[model:<twin>]` where `<twin>` matches `[a-z][a-z0-9_-]*` (lowercase, no
spaces around the `:`), then the criterion text.

* `[code]` = deterministic: graded by checking the twin's real end state.
* `[model]` = probabilistic: graded by the managed judge over the trace.

Authors write `[code]`/`[model]` in markdown; the parsed criterion carries
`type: "code"` or `type: "model"` directly. The optional twin tag lands on
`criterion.twin`; a bare marker leaves it undefined, which attributes the
criterion to the session's primary twin (`twins[0]`).

Lines that do not match the grammar are silently skipped — they are treated
as prose, not rejected. `- [Code] ...` (wrong case), `- [code : github] ...`
(spaces), or a missing bullet all silently produce no criterion, so re-count
your criteria in the `validate_task` output.

One grading caveat that the parser does NOT check: a `[code]` criterion is
graded by matching its text against a per-twin registry of deterministic
predicates (e.g. `Issue #1 has the "bug" label`, `Comment containing "X"
appears on issue #1`, `A message in the "#general" channel contains "X"`).
A `[code]` whose phrasing matches no registered predicate parses fine but
scores `unmatched` — it is never graded. Dry-run your criteria with
`evaluate_criteria` (and `verify_seed` for pre-pass checks) before saving.
Outcomes with no registered predicate (like "the issue is closed") belong
in a `[model]` criterion instead.

Twin-tag validation, exactly as the parser enforces it:

* **Single-twin task** — a tag is allowed but must equal the sole twin.
  Otherwise: `Criterion "[code:slack] <text>" tags twin "slack", but this
  single-twin task runs "github". Drop the tag or set config.twins to
  include "slack".`
* **Multi-twin task** — a tag must name one of the task's twins. Otherwise:
  `Criterion "[code:linear] <text>" tags twin "linear", which is not in the
  task's twins [github, slack].`
* **Multi-twin task** — every `[code]` criterion MUST carry a tag (the cloud
  needs to know which twin's state to check). A bare `[code]` fails with:
  `Criterion "[code] <text>" needs a twin tag ([code:<twin>]) in a multi-twin
  task (twins [github, slack]).` A bare `[model]` is fine — it attributes
  to the primary twin.

## Config

`## Config` holds one fenced YAML block. The fence may be tagged `yaml`,
`json`, or left bare; the first such fence in the section is used (text
outside the fence is ignored; with no fence the whole section is parsed as
YAML). Keys and defaults:

| Key | Type | Default | Constraint |
| --- | --- | --- | --- |
| `twins` | array of twin ids | `["github"]` | The twins mounted for the session. Available twins today: `github`, `slack`, `stripe` — so 1–3 entries in practice. Order matters: `twins[0]` is the primary twin. |
| `timeout` | integer | `60` | Seconds; must be a positive integer. |
| `runs` | integer | `1` | Trials per run-set; must be a positive integer. |
| `passThreshold` | number | `100` | Percent of runs that must pass; `0`–`100`. |

Unknown config keys are silently stripped, not rejected. An absent
`## Config` section means all defaults (a single-twin GitHub task).

## Seed State

`## Seed State` holds one fenced ` ```json ` block (fence tag `json` or bare)
containing the initial world the twin boots from. The rules, in order:

1. **No section (or empty)** → the twin's default seed (see defaults below).
2. **Prose instead of JSON** — if the (unfenced) content does not start with
   `{` or `[`, parsing fails with:

   ```
   Task has a prose ## Seed State section. The MCP surface needs a concrete seed:
   replace the prose with a fenced ```json block containing the seed object
   (or drop the section to use the twin's default seed).
   ```

3. **Malformed JSON** → `Inline JSON seed in ## Seed State is malformed:
   <detail>`.
4. **Valid JSON** → validated against the shape below, chosen by
   `config.twins` alone — never by sniffing the seed's keys.

### Single-twin: flat seed (FDRS-365)

A single-twin task's seed is the twin's flat seed object, with no wrapper of
any kind. The legacy `{ "<twin>": { "seed": ... } }` wrapper is rejected.
Which schema validates it is decided from `config.twins`:

* `twins` includes `stripe` and not `github` → Stripe shape.
* `twins` includes `slack` and neither `github` nor `stripe` → Slack shape.
* Everything else (including the default `["github"]`) → GitHub shape.

### Multi-twin: seed envelope (envelope-iff-multi-twin)

When `config.twins` has more than one entry — and only then — the seed MUST
be a per-twin envelope mapping twin id to that twin's flat seed:

```json
{ "github": { "...": "flat GitHub seed" }, "slack": { "...": "flat Slack seed" } }
```

* Envelope keys must be a subset of the task's twins. An unknown key fails
  loudly: `Seed envelope key "stripe" is not one of the task's twins
  [github, slack].` A flat (non-envelope) seed object surfaces as this same
  error — its top-level keys are seed fields like `repositories`, not twin
  ids.
* A twin with no envelope key gets its default seed.
* No `## Seed State` at all → every twin gets its default seed.
* A seed that is not a JSON object at all (an array or scalar) fails with:
  `Multi-twin tasks need a per-twin seed envelope { <twin>: <seed> } for
  twins [github, slack], not a bare seed object.`

Never wrap a single-twin seed in an envelope, and never write a flat seed
for a multi-twin task — the envelope is decided by `config.twins`, full stop.

### GitHub seed shape

Unknown keys are stripped silently. `repositories` is required and must have
at least one entry (`GitHub seed must contain at least one repository`).

```json
{
  "users": [{ "login": "<required>", "type": "User | Organization (default User)", "name": "<default \"\">" }],
  "repositories": [{
    "owner": "<required>", "name": "<required>",
    "description": "<default \"\">", "private": false, "default_branch": "main",
    "collaborators": ["<login>"],
    "labels": [{ "name": "<required>", "color": "ededed", "description": "" }],
    "files": [{ "path": "<required>", "content": "<required>", "branch": "<optional>" }],
    "issues": [{
      "number": "<optional positive int>", "title": "<required>", "body": "",
      "state": "open | closed (default open)", "labels": [], "assignees": []
    }],
    "pull_requests": [{
      "number": "<optional positive int>", "title": "<required>", "body": "",
      "head": "<required>", "base": "main", "state": "open | closed (default open)",
      "author": "<optional>",
      "reviews": [{ "author": "<required>", "state": "APPROVED | CHANGES_REQUESTED | COMMENTED (default APPROVED)", "body": "" }],
      "statuses": [{ "context": "ci/build", "state": "error | failure | pending | success (default success)", "description": "" }]
    }]
  }]
}
```

Legacy compatibility: an issue's singular `"assignee": "<login>"` is migrated
to `"assignees": ["<login>"]` before validation (`assignee: null` or `""`
becomes `assignees: []`).

### Slack seed shape (strict)

Top-level keys are STRICT — anything besides `team` / `users` / `channels`
is rejected (this is what keeps a GitHub or Stripe seed from silently
mis-parsing as Slack). Element shapes are permissive at parse time; the twin
itself validates them strictly at boot.

```json
{
  "team": { "id": "T_ACME", "name": "Acme", "domain": "acme" },
  "users": [{ "id": "U_PRIMARY", "name": "pome-agent", "real_name": "Pome Agent", "is_admin": true }],
  "channels": [{ "id": "C_GENERAL", "name": "general", "is_private": false, "members": ["U_PRIMARY"], "messages": [] }]
}
```

All three keys are optional (`users` and `channels` default to `[]`).

### Stripe seed shape (strict)

Top-level keys are STRICT — unknown keys (notably the legacy
`stripe: { seed: ... }` wrapper) fail parsing loudly. Every key is optional
and defaults to `[]`:

```json
{
  "api_keys": [{ "key": "sk_test_pome_default", "sid": "default", "account_id": "<optional>" }],
  "customers": [], "products": [], "prices": [],
  "payment_intents": [], "charges": [], "events": [], "balances": [],
  "failure_injection": [{
    "method": "<required>", "path": "<required>", "attempt": 1,
    "mode": "before_handler | after_handler (default after_handler)",
    "status": 500, "body": {}
  }]
}
```

`failure_injection` rules require `method`, `path`, a positive integer
`attempt`, and an integer `status` in 100–599.

### Default seeds (when `## Seed State` is absent)

* **github** — the bundled default world: an `acme` org with users `alice`,
  `bob`, `pome-agent`; one repository `acme/api` with labels
  `bug`/`feature`/`question`, a `README.md` and `src/index.ts`, and one open
  seeded bug issue.
* **slack** — an empty seed `{}`; the twin fills the default workspace at
  boot.
* **stripe** — `{ "api_keys": [{ "key": "sk_test_pome_default", "sid":
  "default", "account_id": "acct_default" }] }`.

## Error reporting

Validation failures are reported as `Invalid task: <message>`; schema
failures list each field path, e.g. `Invalid task: prompt: <detail>;
criteria: <detail>`.

## Worked examples

Each example below is a complete task document that parses clean against the
parser above (they are verified by a unit test in
`apps/mcp/test/task-format-doc.test.ts`).

### Example 1 — single-twin GitHub

````markdown
# Triage the crash report

## Prompt
A user reported that POST /orders started returning 500s after the last
deploy. Find the matching open issue in acme/api, label it `bug`, and leave
a comment summarizing the likely cause based on the issue body.

## Setup
You have GitHub access to the acme/api repository as pome-agent.

## Expected Behavior
The agent locates the open crash issue, applies the existing `bug` label
(it does not invent a new label), and comments with a short root-cause
hypothesis that mentions the deploy.

## Success Criteria
- [code] Issue #1 has the "bug" label
- [code] Comment containing "deploy" appears on issue #1
- [model] The comment gives a plausible root-cause hypothesis tied to the deploy

## Config
```yaml
twins: [github]
timeout: 300
```

## Seed State
```json
{
  "users": [{ "login": "acme", "type": "Organization", "name": "Acme" }],
  "repositories": [
    {
      "owner": "acme",
      "name": "api",
      "description": "Order API",
      "collaborators": ["pome-agent"],
      "labels": [{ "name": "bug", "color": "d73a4a", "description": "Something is not working" }],
      "issues": [
        {
          "title": "500 error on POST /orders after deploy",
          "body": "Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.",
          "state": "open"
        }
      ]
    }
  ]
}
```
````

### Example 2 — single-twin Slack

````markdown
# Answer the on-call question

## Prompt
A teammate asked in #oncall how to rotate the staging database credentials.
Reply in the #oncall channel pointing them at the rotation runbook
(go/rotate-staging), and do not post any secret values in the channel.

## Setup
You have Slack access to the Acme workspace as pome-agent. The rotation
runbook lives at go/rotate-staging.

## Expected Behavior
The agent posts one helpful reply in #oncall linking the go/rotate-staging
runbook, without pasting credentials or key material.

## Success Criteria
- [code:slack] A message in the "#oncall" channel contains "go/rotate-staging"
- [code:slack] No message containing "sk-prod" appears in any public channel
- [model] The reply explains the rotation steps without revealing any secret value

## Config
```yaml
twins: [slack]
timeout: 180
```

## Seed State
```json
{
  "team": { "id": "T_ACME", "name": "Acme", "domain": "acme" },
  "users": [
    { "id": "U_PRIMARY", "name": "pome-agent", "real_name": "Pome Agent", "is_admin": true },
    { "id": "U_DANA", "name": "dana", "real_name": "Dana Oncall" }
  ],
  "channels": [
    {
      "id": "C_ONCALL",
      "name": "oncall",
      "is_private": false,
      "members": ["U_PRIMARY", "U_DANA"],
      "messages": [
        { "user": "U_DANA", "text": "How do I rotate the staging database credentials?" }
      ]
    }
  ]
}
```
````

### Example 3 — multi-twin GitHub + Slack (seed envelope)

````markdown
# Announce the hotfix

## Prompt
The hotfix for the checkout crash just merged in acme/checkout. Close the
open hotfix-tracking issue with a comment noting the fix shipped, and post
an announcement in the #releases Slack channel that mentions the hotfix.

## Setup
You have GitHub access to acme/checkout and Slack access to the Acme
workspace.

## Expected Behavior
The agent closes the tracking issue with a shipped-note comment, then posts
one announcement in #releases referencing the hotfix.

## Success Criteria
- [code:github] Comment containing "hotfix" appears on issue #1
- [code:slack] A message in the "#releases" channel contains "hotfix"
- [model] The tracking issue was closed after the fix shipped
- [model] The announcement accurately describes what the hotfix changed

## Config
```yaml
twins: [github, slack]
timeout: 420
```

## Seed State
```json
{
  "github": {
    "repositories": [
      {
        "owner": "acme",
        "name": "checkout",
        "description": "Checkout service",
        "collaborators": ["pome-agent"],
        "issues": [
          {
            "title": "Hotfix tracking: checkout crash on discounted items",
            "body": "Close when the hotfix ships and is announced.",
            "state": "open"
          }
        ]
      }
    ]
  },
  "slack": {
    "team": { "id": "T_ACME", "name": "Acme" },
    "users": [{ "id": "U_PRIMARY", "name": "pome-agent", "real_name": "Pome Agent", "is_admin": true }],
    "channels": [
      { "id": "C_RELEASES", "name": "releases", "is_private": false, "members": ["U_PRIMARY"], "messages": [] }
    ]
  }
}
```
````
