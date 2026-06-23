import { afterAll, beforeAll } from "vitest";

const prevSecret = process.env.TWIN_AUTH_SECRET;
const prevDeterministic = process.env.SLACK_DETERMINISTIC_TS;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = process.env.TWIN_AUTH_SECRET ?? "test-secret-32-chars-minimum-length";
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = prevSecret;
  if (prevDeterministic === undefined) delete process.env.SLACK_DETERMINISTIC_TS;
  else process.env.SLACK_DETERMINISTIC_TS = prevDeterministic;
});
