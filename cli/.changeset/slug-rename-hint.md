---
"@pome-sh/cli": patch
---

`pome register agent` and `pome install` now print a one-time notice when the control plane resolves your `pome.json` `agent.slug` to a renamed agent via a slug alias: it names the old and new slug, confirms `pome.json` was rewritten to the new canonical slug, and surfaces the server's hint. Attribution already self-healed silently (the CLI writes the returned slug back to the manifest); this just makes the rename visible. No notice on a normal live-slug resolve or a fresh registration.
