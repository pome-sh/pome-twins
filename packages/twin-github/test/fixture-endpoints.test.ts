import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

// Smoke test over the seeded read surfaces that the (now-removed) fidelity
// fixture-shape test used to exercise. The shape-parity check itself moved to
// pome-cloud's Twin Fidelity Watch (it owns the diff engine + golden fixtures);
// this keeps the twin's route-handler coverage and proves each seeded read
// surface still answers 200 + JSON against a fresh app.

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

const paths = [
  "/repos/acme/api/contents/README.md",
  "/repos/acme/api/contents/src",
  "/repos/acme/api/commits",
  "/repos/acme/api/issues",
  "/search/repositories?q=acme",
  "/search/issues?q=500",
] as const;

describe("GitHub twin — seeded read endpoints", () => {
  it.each(paths)("GET %s returns 200 + JSON", async (path) => {
    const response = await createGitHubCloneApp().request(`${base}${path}`, withAuth(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    // Arrays (lists) and objects (single resources / search envelopes) both
    // satisfy this; the point is the handler ran and produced a JSON body.
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });
});
