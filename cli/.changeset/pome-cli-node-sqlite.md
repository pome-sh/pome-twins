---
"@pome-sh/cli": patch
---

Zero native dependencies: better-sqlite3 is gone from the install closure (F-704). The bundled twin engine now runs on the `node:sqlite` builtin (`@pome-sh/sdk` 0.3.1, twins 0.1.2/0.1.2/0.2.2), so `npm install`/`npx` needs no compiler toolchain. No behavior changes.
