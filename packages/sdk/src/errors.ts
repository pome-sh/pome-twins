// SPDX-License-Identifier: Apache-2.0
//
// Generic SDK error envelope. Twin authors can throw `TwinError` from
// handlers to surface a non-200 response with a custom message; the
// recorder middleware unwraps it into the standard envelope and records
// the error string per recording-spec.md v1.0.

import { z } from "zod";

export class TwinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: unknown[]
  ) {
    super(message);
    this.name = "TwinError";
  }
}

export interface ErrorEnvelope {
  status: number;
  body: { message: string; errors?: unknown[] };
}

export function envelopeFor(error: unknown): ErrorEnvelope {
  if (error instanceof TwinError) {
    return {
      status: error.status,
      body: { message: error.message, ...(error.errors ? { errors: error.errors } : {}) },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 422,
      body: {
        message: "Validation Failed",
        errors: error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, body: { message: "Problems parsing JSON" } };
  }
  return {
    status: 500,
    body: { message: error instanceof Error ? error.message : "Internal Server Error" },
  };
}
