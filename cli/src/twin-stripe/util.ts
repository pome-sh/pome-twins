// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

export function requestId() {
  return `req_${randomUUID()}`;
}
