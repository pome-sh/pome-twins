// SPDX-License-Identifier: Apache-2.0
export class TwinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: unknown[]
  ) {
    super(message);
  }
}

export function githubError(message: string, status: number, errors?: unknown[]) {
  return {
    message,
    documentation_url: "https://docs.github.com/rest",
    status,
    ...(errors ? { errors } : {})
  };
}

export function notFound(message = "Not Found"): never {
  throw new TwinError(message, 404);
}

export function conflict(message: string): never {
  throw new TwinError(message, 409);
}

export function validationFailed(field: string, code: string, value?: unknown): never {
  throw new TwinError("Validation Failed", 422, [
    {
      resource: "Request",
      field,
      code,
      ...(value === undefined ? {} : { value })
    }
  ]);
}
