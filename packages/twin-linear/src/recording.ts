// SPDX-License-Identifier: Apache-2.0
import type { RecorderEvent } from "@pome-sh/sdk";

const SECRET_KEYS = new Set([
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "token",
  "secret",
  "authorization",
  "code_verifier",
  "codeverifier",
  "password",
]);

export function projectLinearRecording(event: RecorderEvent): RecorderEvent {
  return {
    ...event,
    request_body: projectValue(event.request_body),
    response_body: projectValue(event.response_body),
    state_delta: projectValue(event.state_delta) as RecorderEvent["state_delta"],
    error: projectValue(event.error) as RecorderEvent["error"],
  };
}

function projectValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, key));
  if (!value || typeof value !== "object") {
    return shouldRedact(key) && typeof value === "string" ? "[redacted]" : value;
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = projectValue(child, childKey);
  }
  return out;
}

function shouldRedact(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_KEYS.has(normalized)) return true;
  if (normalized.includes("secret")) return true;
  if (normalized.includes("authorization")) return true;
  return false;
}
