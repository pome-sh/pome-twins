import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

const dbPath = process.env.SLACK_CLONE_DB ?? ".slack_clone/slack.db";
const db = openSlackTwinDatabase(dbPath);
new SlackDomain(db).seed(defaultSeedState());
db.close();

console.log(`Seeded Slack twin database at ${dbPath}`);
