---
"pome-sh": patch
---

**F0-6 / L9 — `--api-url` flag now propagates as documented.**

Before this change, `pome run --api-url http://127.0.0.1:9999` silently kept contacting `https://api.pome.sh`. Verified during the 2026-05-27 launch test plan walkthrough: a mock server at the flag's host received zero requests; the CLI returned a PASS from the real cloud.

Root cause was in `cli/src/cli/credentials.ts`. The `resolveCredentials` helper's URL-precedence ladder was `process.env.POME_API_URL ?? keychain.api_url ?? input.apiBaseUrl`. When `POME_API_URL` was unset, the stored `api_url` written into Keychain by `pome login` (always `https://api.pome.sh`) shadowed the explicit `--api-url` flag. The `POME_API_URL` env var works as a side-channel only because main.ts's Commander option default folds it into the flag value before the ladder reaches it.

Flipped the precedence so `input.apiBaseUrl` (which `cli/main.ts` already resolves as `--api-url > POME_API_URL env > DEFAULT`) wins over stored values. Stored `api_url` is now used only when the caller passes no override. Added regression test asserting caller-passed `apiBaseUrl` wins over Keychain stored `api_url`.

Behavior change: enterprise users who relied on `pome login --api-url https://internal/api` persisting that URL across subsequent runs without setting `POME_API_URL` are now expected to either pass `--api-url` per command or export `POME_API_URL` in their shell. Stage 1 launch has a single control plane, so this is a non-issue for the vast majority of users.
