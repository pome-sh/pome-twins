---
"@pome-sh/cli": patch
---

Blob uploads (trace, per-twin state, signals, meta) are now gzip-encoded. The storage edge runs a content rule that rejects some twin-state payloads sent as plaintext, which silently dropped those uploads and skipped their criteria. Uploads now carry `content-encoding: gzip`, so the payloads sail through; this requires the paired cloud reader release that transparently decompresses them.
