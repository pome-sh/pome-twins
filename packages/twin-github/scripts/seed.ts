import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

const dbPath = process.env.GITHUB_CLONE_DB ?? ".github_clone/github.db";
const db = openGitHubCloneDatabase(dbPath);
new GitHubDomain(db).seed(defaultSeedState());
db.close();

console.log(`Seeded GitHub clone database at ${dbPath}`);
