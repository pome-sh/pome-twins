<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/shared-types

The shared wire-format contract for [Pome](https://pome.sh) — Zod schemas
and TypeScript types for traces, recorder events, runs, task seeds,
OTel span mapping, and secret redaction. The `pome` CLI, the twin engine
(`@pome-sh/sdk`), the first-party twins, the Claude adapter, and the Pome
cloud all speak this vocabulary; the wire format is the contract, not any
one library.

## Install

```bash
npm install @pome-sh/shared-types zod
```

`zod` (^4.1.13) is a peer dependency.

## Usage

```ts
import { recorderEventSchema, redactSecrets } from "@pome-sh/shared-types";
import { eventSchema } from "@pome-sh/shared-types/recorder-events";

const event = recorderEventSchema.parse(row);
const safe = redactSecrets(JSON.stringify(event));
```

Subpath exports: `recorder-events`, `run`, `otel`, `otel/fixtures`, and
`redaction`. The machine-readable trace contract ships as
`trace-contract.json` inside the package.

## Docs

Full documentation at [docs.pome.sh](https://docs.pome.sh). Source and
issues at [pome-sh/pome-twins](https://github.com/pome-sh/pome-twins).

## License

Apache-2.0
