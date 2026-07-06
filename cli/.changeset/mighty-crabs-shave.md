---
"pome-sh": patch
---

`npm install -g pome-sh` now yields a runnable `pome` with no manual `chmod`: the build stamps the executable bit on `dist/src/cli/main.js`, so the published tarball carries it (`npm pack` preserves disk modes; tsc emits 644). FDRS-666.
