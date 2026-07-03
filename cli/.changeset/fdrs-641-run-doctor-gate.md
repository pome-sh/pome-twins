---
"pome-sh": minor
---

**`pome run` now gates on the doctor preflight (FDRS-641).**

A repo failing any applicable doctor check refuses to spawn the agent —
before credentials are resolved and before any twin/session is provisioned —
printing the doctor output (one named cause + one concrete fix) and exiting
non-zero. There is deliberately no `--force` / `--skip-checks` escape: pome
will not run trials against a live API. Local runs get the full engine
(including the in-process twin boot); hosted runs skip the local twin boot
(the cloud provisions the session twin) but still gate on config, routing,
and the egress floor.

Breaking for config-less flows: `pome run` now requires a `pome.config.json`
(run `pome init`, or `pome install` once it lands) even when `--agent` is
passed explicitly.
