---
"pome-sh": patch
---

Self-host post-run merge now **interleaves** signal rows with existing
`events.jsonl` rows in ts order rather than appending them at the tail
(FDRS-412). Capture-server writes `LlmCallEvent` rows when each CONNECT
tunnel closes, so the on-disk events.jsonl is not guaranteed to be
chronologically sorted at write time; the merge step now reads the file,
concat + stable-sorts with the validated signal rows, and rewrites the
file ts-ordered. `pome inspect` and the dashboard upload now consume a
canonical timeline regardless of capture-close ordering. Unparseable
existing rows are passed through at the head of the file (no data loss).
