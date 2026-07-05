// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — trial-group identity for `pome demo`.
//
// One `grp_` + nanoid21 id per demo invocation, shared by all k=5 demo
// sessions (mint body `group_id`), copied by the cloud onto
// `sessions.group_id` at mint and `runs.group_id` at finalize, and forming
// the no-login preview URL `app.pome.sh/demo/<group_id>`.
//
// Format contract: the cloud validates `^[A-Za-z0-9_-]{6,64}$`
// (isValidGroupId in pome-cloud lib/demo.ts). "grp_" + 21 url-safe chars =
// 25 chars, comfortably inside.

import { randomBytes } from "node:crypto";

const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** nanoid-shaped random string over the url-safe 64-char alphabet. */
export function nanoid(size = 21): string {
  const bytes = randomBytes(size);
  let id = "";
  for (let i = 0; i < size; i += 1) {
    // 64-char alphabet ⇒ 6 bits per char; masking keeps the distribution
    // uniform (no modulo bias).
    id += NANOID_ALPHABET[bytes[i]! & 63];
  }
  return id;
}

/** Mint one trial-group id: `grp_` + nanoid21. */
export function newGroupId(): string {
  return `grp_${nanoid(21)}`;
}
