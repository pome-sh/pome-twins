# /v1 wire fixture corpus (FDRS-613)

A shared, framework-agnostic JSON corpus of representative `/v1` wire payloads.
It is the parity anchor between `pome-sh/pome-twins` (this repo, zod 4) and
`pome-sh/pome-cloud` (zod 3). Both repos parse **the same JSON files** against
their own copy of the schema; if a represented payload becomes incompatible on
either `/v1` surface, one side starts failing to parse a fixture the other side
still accepts.

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
parse. The `*TaskVocab` dirs hold new-vocabulary payloads. The cloud-side
parity map gains the `*TaskVocab` dirs at the FDRS-654 consumer swap (its
schema is 0.3.0-era until then and iterates only its own dir list, so the new
dirs are invisible to it in the meantime — do NOT add new-vocab payloads to
the original dirs before FDRS-654 lands).

## Scope

Deliberately scoped to the `/v1` wire surface (`planTier`, `createSession`,
`usage`, `run`). It is **not** whole-file byte parity, whole-schema equality, or
a guard for every possible loosening/removal, and it does **not** cover
cloud-only billing schemas. Note the two repos pin different zod majors (twins
`^4`, cloud `^3`), so byte-for-byte file parity is a non-goal — represented
fixture parse parity via this corpus is the contract.

## How each repo consumes it

- twins: `packages/shared-types/test/v1-fixture-parity.test.ts`
- cloud: fetched by `.github/workflows/shared-types-v1-parity.yml` and parsed
  against the cloud schema; injected drift fails the job.
