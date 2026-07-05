---
"pome-sh": patch
---

Live-run fixes from the first real `pome demo` round-trip (FDRS-643): the
finalize-response reader now tolerates the unified `code`/`model` criterion
vocabulary the post-W3 cloud judge emits (legacy `D`/`P` still accepted), and
`deleteSession` sends the configured auth scheme instead of a hardcoded
`x-api-key` header (demo teardown carries a bearer `demo_token`).
