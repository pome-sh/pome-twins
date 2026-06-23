// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";

export function generateToolCallId(): string {
  return `tlc_${randomBytes(4).toString("hex")}`;
}

export function generateEventId(): string {
  return `evt_${randomBytes(8).toString("hex")}`;
}
