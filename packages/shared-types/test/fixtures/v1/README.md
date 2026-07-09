# /v1 wire fixture corpus (FDRS-613)

A shared, framework-agnostic JSON corpus of representative `/v1` wire payloads.
`pome-sh/pome-twins` is the canonical home for these fixtures and the
`@pome-sh/shared-types` package that parses them. Cloud consumers validate
against the published package contract; they no longer mirror this source tree
as a second owner.

## Layout

One directory per `/v1` schema. The directory name is the schema key:

```
planTier/                        → planTierSchema
createSessionRequest/            → createSessionRequestSchema  (POST /v1/sessions; 0.3.0-era scenario_* vocab)
createSessionRequestTaskVocab/   → createSessionRequestSchema  (W3 task_* vocab, FDRS-653)
createSessionResponse/           → createSessionResponseSchema (POST /v1/sessions)
usage/                           → usageResponseSchema         (GET  /v1/usage)
run/                             → runSchema                   (Run row; 0.3.0-era scenario_* vocab)
runTaskVocab/                    → runSchema                   (W3 task_* vocab, FDRS-653)
```

Each `*.json` file is a single wire value: an object, or (for `planTier`) a
bare JSON string. Every fixture MUST parse successfully under the mapped schema.

### The two vocabularies (FDRS-653)

Shared-types 0.5.0 renamed everything "scenario" to "task" on the wire (and
criterion kinds `D`/`P` to `code`/`model`) behind a tolerant reader. The
original dirs deliberately KEEP their 0.3.0-era payloads: they are the proof
that 0.3.0 artifacts (and shipped CLIs vendoring shared-types 0.3.0) still
parse. The `*TaskVocab` dirs hold new-vocabulary payloads. Do NOT add
new-vocab payloads to the original dirs; those directories remain the
tolerant-reader compatibility corpus.

## Scope

Deliberately scoped to the `/v1` wire surface (`planTier`, `createSession`,
`usage`, `run`). It is **not** whole-file byte parity, whole-schema equality, or
a guard for every possible loosening/removal, and it does **not** cover
cloud-only billing schemas. Byte-for-byte repo parity is a non-goal after M8;
represented fixture parsing through the published package is the contract.

## How this repo consumes it

`packages/shared-types/test/v1-fixture-parity.test.ts` parses every fixture under
the mapped schema. Downstream repos should consume the published
`@pome-sh/shared-types` package instead of vendoring or mirroring this corpus.
