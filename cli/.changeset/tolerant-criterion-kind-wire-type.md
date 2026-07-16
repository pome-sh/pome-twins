---
"@pome-sh/cli": patch
---

Internal: type the hosted finalize payload's criteria as the wire *input* shape (`CriterionDefInput`). No behavior change — the CLI still sends the legacy `D`/`P` criterion kinds until the hosted service accepts the canonical `code`/`model` spellings.
