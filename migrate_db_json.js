import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  getPool,
  initDb,
  findUserByGoogleSub,
  createUserFromGoogle,
  createJournalEntry,
  saveAnalysis,
} from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "db.json");

async function migrate() {
  console.log("Starting db.json to PostgreSQL migration...");
  if (!fs.existsSync(DB_PATH)) {
    console.log("No db.json found. Nothing to migrate.");
    return;
  }

  let dbData = {};
  try {
    dbData = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (err) {
    console.error("Could not parse db.json:", err.message);
    return;
  }

  const pool = getPool();
  if (!pool) {
    console.error("DATABASE_URL is not configured in environment. Set it in .env first.");
    process.exit(1);
  }

  await initDb();

  const userKeys = Object.keys(dbData);
  console.log(`Found ${userKeys.length} legacy user profiles in db.json.`);

  for (const legacyId of userKeys) {
    const legacyUser = dbData[legacyId];
    if (!legacyUser) continue;

    const googleSub = `legacy:${legacyId}`;
    const email = `${legacyId}@legacy.local`;

    let user = await findUserByGoogleSub(googleSub);
    if (!user) {
      user = await createUserFromGoogle({
        googleSub,
        email,
        name: `User (${legacyId})`,
      });
      console.log(`Created user ${user.id} for legacy profile ${legacyId}.`);
    }

    if (Array.isArray(legacyUser.entries)) {
      for (const entry of legacyUser.entries) {
        if (!entry || !entry.text) continue;
        try {
          await createJournalEntry(user.id, {
            id: entry.id || Date.now().toString(),
            text: entry.text,
            source: entry.source || "written",
            flags: entry.flags || [],
            date: entry.date || new Date().toISOString(),
            dateDisplay: entry.dateDisplay || null,
          });
        } catch (e) {
          // Ignore duplicate primary keys on re-runs
        }
      }
      console.log(`Migrated ${legacyUser.entries.length} entries for ${legacyId}.`);
    }

    if (legacyUser.analyses && typeof legacyUser.analyses === "object") {
      for (const [cacheId, a] of Object.entries(legacyUser.analyses)) {
        if (!a || !a.summary) continue;
        await saveAnalysis(user.id, {
          cacheId,
          scope: a.scope || "period",
          label: a.label,
          recallDays: a.recallDays || 30,
          summary: a.summary,
          similarities: a.similarities || [],
          summaryDate: a.summaryDate || new Date().toISOString(),
        });
      }
    }
  }

  console.log("Migration finished successfully.");
}

migrate()
  .catch(console.error)
  .finally(() => {
    const pool = getPool();
    if (pool) pool.end();
  });
