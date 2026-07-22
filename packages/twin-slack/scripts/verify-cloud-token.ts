// SPDX-License-Identifier: Apache-2.0
// Verifies that the xoxb-pome-<sid>-<sig> token shape the cloud control-plane
// signs (pome-cloud/apps/control-plane/src/lib/provider-credentials.ts) is
// accepted by the twin's auth middleware, end-to-end. This is the contract
// that lets a hosted Slack session work without any extra configuration.
import { createHmac } from "node:crypto";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

process.env.SLACK_DETERMINISTIC_TS = "1";
process.env.TWIN_AUTH_SECRET = "shared-cloud-secret-32-chars-minimum";

const SID = "ses_verify_cloud";

// Cloud-side build (must match provider-credentials.ts exactly).
function cloudBuildToken(sessionId: string, secret: string): string {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(`slack:${sessionId}`).digest("base64url").slice(0, 22);
  return `xoxb-pome-${encoded}_${sig}`;
}

const token = cloudBuildToken(SID, process.env.TWIN_AUTH_SECRET);
console.log("issued token:", token);

const db = openSlackTwinDatabase(":memory:");
const domain = new SlackDomain(db);
domain.seed(defaultSeedState());
const app = createSlackTwinApp({ db, domain, runId: "cloud-verify" });

const res = await app.request(`/s/${SID}/auth.test`, {
  headers: { Authorization: `Bearer ${token}` },
});
const body = (await res.json()) as Record<string, unknown>;

if (res.status !== 200) {
  console.error("FAIL: cloud token rejected", res.status, body);
  process.exit(1);
}
if (body.ok !== true) {
  console.error("FAIL: body.ok !== true", body);
  process.exit(1);
}
if (body.team_id !== "T_POME") {
  console.error("FAIL: unexpected team_id", body);
  process.exit(1);
}
console.log("PASS: cloud-issued xoxb-pome token validates and returns Slack envelope");
console.log("    team_id:", body.team_id);
console.log("    user_id:", body.user_id);
