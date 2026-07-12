# Endpoint tiers: heat × fidelity

Engine-level rubric for every Pome twin. Each twin's `FIDELITY.md` references
this page; per-twin tier rulings are recorded as `[DECISION]` comments on the
milestone's H-gate ticket (M5: F-729).

## Two orthogonal dimensions

| Dimension | Question it answers | Values | Owner |
| --- | --- | --- | --- |
| **Heat** | How deep *should* this endpoint be? | `hot` / `warm` / `cold` | Product judgment — ruled by a founder `[DECISION]` |
| **Fidelity** | How deep *is* it today? | `semantic` / `shape` / `unsupported` | Engineering fact — measured by tests (see each twin's `FIDELITY.md`) |

The two are orthogonal: heat never changes because an implementation landed or
regressed, and fidelity never changes because a ruling did. The existing
`Tier` column in every `FIDELITY.md` means **fidelity** (it is emitted from
`ToolSpec.fidelity` by `packages/sdk/src/fidelity.ts`). Heat is carried in a
separate `Heat` column and a separate structured-inventory field, so the two
dimensions are lintable independently.

## Heat tiers and their criteria

A tier assignment must cite a defensible criterion, not a vibe. The criteria:

- **`hot`** — the endpoint lies on a **core agent task chain**: a task users
  routinely delegate to an autonomous agent against this API (e.g. "collect a
  payment", "triage this issue", "post the report to the channel"), or it is
  in the upstream vendor's **default-enabled** agent toolset. If the twin is
  shallow here, agent evals silently diverge from production behavior — the
  worst failure mode a twin can have. **Target fidelity: `semantic`.**
- **`warm`** — adjacent to a hot chain: context reads, occasional side steps,
  undo/cleanup actions, or a chain that is real but too long or too rare to
  justify semantic modeling now. An agent must never trip a loud failure
  here, but must not rely on deep side effects either. **Target fidelity:
  `shape`.**
- **`cold`** — not plausibly on an autonomous agent's task chain: redirect
  flows built for human browsers, admin/enterprise surfaces, client-UI
  concepts, or anything outside the twin's product scope. Agents that do call
  it must fail loudly, never silently succeed. **Target fidelity:
  `unsupported`** (the twin's documented 501 envelope).

The target mapping is **exact**, not a minimum:

| Heat | Target fidelity | Fidelity below target | Fidelity above target |
| --- | --- | --- | --- |
| `hot` | `semantic` | **gap** — fill or explicitly defer | — |
| `warm` | `shape` | **gap** — fill or explicitly defer | **tier-mismatch** — ledger entry |
| `cold` | `unsupported` | — | **tier-mismatch** — ledger entry |

- A **gap** (implementation shallower than the ruling demands) is tracked in
  the structured inventory. A milestone's implementation tickets decide which
  gaps they fill; a gap left open carries an explicit defer note. A gap is
  never closed by silently softening the heat ruling.
- A **tier-mismatch** (implementation deeper than the ruling demands) is
  recorded in the twin's `FIDELITY.md` tier-mismatch ledger. Per the M5
  additive-only ruling (project `[DECISION]` 2026-07-11), mismatches are
  **never demoted in code mid-milestone** — they become follow-up tickets.
  The ledger exists so over-investment is visible, not to trigger removals.

## Classification method (ruled 2026-07-11)

Per the project `[DECISION]`, heat is assigned by:

1. **Task-chain enumeration (the skeleton).** Enumerate the tasks agents
   perform against this API; every endpoint on those chains is `hot`.
2. **Cross-validation against the upstream vendor's official MCP server
   toolset.** Default-enabled vendor tools corroborate `hot`; opt-in or
   absent corroborate `warm`/`cold`. When the vendor signal and the task
   chain disagree, the task chain wins and the disagreement is noted in the
   justification.
3. **Trace supplement.** Our own trace data / public agent corpora, where
   available.

Every inventory row cites at least one evidence code in its justification:

| Code | Meaning |
| --- | --- |
| `TC:<chain>` | On the named agent task chain |
| `MCP:<tool/toolset>` | Present in the vendor's official MCP toolset (default-on unless noted) |
| `TR` | Supported by trace data / public agent corpora |
| `SB` | Sandbox enabler — a write the sealed twin needs so a chain is exercisable at all (e.g. minting CI statuses) |
| `PS` | Product-scope ruling — deliberately outside what this twin models |

## Inventory scope

The `hot` and `warm` sets are **exhaustive** — every endpoint ruled hot or
warm appears in the inventory, implemented or not. The `cold` set is
**named-only**: an endpoint gets an explicit `cold` row only when agents
plausibly probe it (so the loud 501 is documented and test-backed). The
remaining tail of the upstream API is implicitly cold via each twin's 501
catch-all and carries no inventory row.

Engine introspection (`/healthz`, `/_pome/*`, `/admin/*`, the MCP transport
routes) is outside the inventory — it is pome surface, not upstream surface.

## Where the values live

- **`FIDELITY.md`** — each twin's tables gain a `Heat` column next to the
  existing fidelity `Tier` column, plus a `## Tier-mismatch ledger` section.
- **Structured inventory** (owned by F-730) — one machine-readable record per
  surface: `{ surface, kind: rest|mcp, heat, fidelity, justification }`.
  Surface counts live here; the `/healthz` shape is contract-frozen and does
  not carry them (`tools` remains the MCP tool count; twin-slack intentionally
  has no fidelity field).
- **Lint rules** (enforced by the F-730 runner, checked separately per
  dimension):
  1. Every implemented upstream surface (REST route or MCP tool) has exactly
     one inventory record with heat, fidelity, and justification.
  2. `hot` + fidelity ≠ `semantic` → must appear in the gap list with a
     ticket reference or an explicit defer note.
  3. Fidelity above heat target → must appear in the tier-mismatch ledger.
  4. Named `cold` surfaces must return the twin's documented 501 envelope,
     test-backed.
  5. `FIDELITY.md` heat/fidelity values must equal the inventory's.

## Ruling and change control

Heat rulings are founder decisions, recorded as `[DECISION]` comments on the
milestone H-gate ticket that cut them. Changing an endpoint's heat requires a
new ruling the same way; no code change, test result, or vendor toolset
update reclassifies heat on its own — those are inputs to the next ruling,
not the ruling itself.
