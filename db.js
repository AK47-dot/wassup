import pg from "pg";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  const isLocalhost =
    connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

  pool = new Pool({
    connectionString,
    ssl: isLocalhost ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client:", err.message);
  });

  return pool;
}

// In-memory relational store fallback when DATABASE_URL is not set (e.g. offline testing)
class MemoryDb {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.entries = new Map();
    this.analyses = new Map();
    this.rateLimits = [];
  }

  async query(text, params = []) {
    // Basic normalized query router for local fallback
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO users")) {
      const id = crypto.randomUUID();
      const [googleSub, email, name, picture] = params;
      const user = {
        id,
        google_sub: googleSub,
        email,
        name,
        picture,
        recall_days: 30,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.users.set(id, user);
      return { rows: [user] };
    }
    if (q.includes("FROM users WHERE google_sub = $1")) {
      const user = Array.from(this.users.values()).find((u) => u.google_sub === params[0]);
      return { rows: user ? [user] : [] };
    }
    if (q.includes("FROM users WHERE id = $1")) {
      const user = this.users.get(params[0]);
      return { rows: user ? [user] : [] };
    }
    if (q.startsWith("INSERT INTO sessions")) {
      const [id, userId, expiresAt] = params;
      const session = { id, user_id: userId, expires_at: new Date(expiresAt), created_at: new Date() };
      this.sessions.set(id, session);
      return { rows: [session] };
    }
    if (q.includes("FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = $1")) {
      const session = this.sessions.get(params[0]);
      if (!session || new Date(session.expires_at) <= new Date()) {
        return { rows: [] };
      }
      const user = this.users.get(session.user_id);
      if (!user) return { rows: [] };
      return {
        rows: [
          {
            session_id: session.id,
            expires_at: session.expires_at,
            id: user.id,
            google_sub: user.google_sub,
            email: user.email,
            name: user.name,
            picture: user.picture,
            recall_days: user.recall_days,
            created_at: user.created_at,
            updated_at: user.updated_at,
          },
        ],
      };
    }
    if (q.startsWith("DELETE FROM sessions WHERE id = $1")) {
      this.sessions.delete(params[0]);
      return { rowCount: 1 };
    }
    if (q.includes("FROM journal_entries WHERE user_id = $1 ORDER BY entry_date ASC")) {
      const userEntries = Array.from(this.entries.values())
        .filter((e) => e.user_id === params[0])
        .sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date));
      return { rows: userEntries };
    }
    if (q.startsWith("INSERT INTO journal_entries")) {
      const [id, userId, entryText, source, flags, entryDate, dateDisplay] = params;
      const isoDate = new Date(entryDate).toISOString();
      const entry = {
        id,
        user_id: userId,
        text: entryText,
        source: source || "written",
        flags: typeof flags === "string" ? JSON.parse(flags) : flags || [],
        entry_date: isoDate,
        date: isoDate,
        date_display: dateDisplay,
        dateDisplay: dateDisplay,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.entries.set(id, entry);
      return { rows: [entry] };
    }
    if (q.startsWith("UPDATE users SET recall_days = $1, updated_at = NOW() WHERE id = $2")) {
      const user = this.users.get(params[1]);
      if (user) {
        user.recall_days = params[0];
        user.updated_at = new Date();
      }
      return { rowCount: user ? 1 : 0 };
    }
    if (q.includes("FROM ai_analyses WHERE user_id = $1")) {
      const analyses = Array.from(this.analyses.values()).filter((a) => a.user_id === params[0]);
      return { rows: analyses };
    }
    if (q.includes("INSERT INTO ai_analyses")) {
      const [userId, cacheId, scope, label, recallDays, summaryData, similarities, summaryDate] = params;
      const existingKey = `${userId}:${cacheId}`;
      const analysis = {
        user_id: userId,
        cache_id: cacheId,
        scope,
        label,
        recall_days: recallDays,
        summary_data: typeof summaryData === "string" ? JSON.parse(summaryData) : summaryData,
        similarities: typeof similarities === "string" ? JSON.parse(similarities) : similarities,
        summary_date: new Date(summaryDate).toISOString(),
      };
      this.analyses.set(existingKey, analysis);
      return { rows: [analysis] };
    }
    if (q.includes("FROM ai_rate_limits WHERE user_id = $1 AND created_at >= $2")) {
      const userId = params[0];
      const since = new Date(params[1]);
      const count = this.rateLimits.filter((r) => r.user_id === userId && r.created_at >= since).length;
      return { rows: [{ count: String(count) }] };
    }
    if (q.startsWith("INSERT INTO ai_rate_limits")) {
      this.rateLimits.push({ user_id: params[0], created_at: new Date() });
      return { rowCount: 1 };
    }
    if (q.startsWith("DELETE FROM users WHERE id = $1")) {
      const userId = params[0];
      this.users.delete(userId);
      for (const [sId, s] of this.sessions.entries()) {
        if (s.user_id === userId) this.sessions.delete(sId);
      }
      for (const [eId, e] of this.entries.entries()) {
        if (e.user_id === userId) this.entries.delete(eId);
      }
      for (const [aId, a] of this.analyses.entries()) {
        if (a.user_id === userId) this.analyses.delete(aId);
      }
      this.rateLimits = this.rateLimits.filter((r) => r.user_id !== userId);
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

export const memoryDb = new MemoryDb();

export async function query(text, params = []) {
  const p = getPool();
  if (p) {
    return p.query(text, params);
  }
  return memoryDb.query(text, params);
}

export async function initDb() {
  const p = getPool();
  if (!p) {
    return;
  }

  const schemaPath = path.join(__dirname, "schema.sql");
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, "utf-8");
    await p.query(sql);
  }
}

// User repository operations
export async function findUserByGoogleSub(googleSub) {
  const res = await query("SELECT * FROM users WHERE google_sub = $1", [googleSub]);
  return res.rows[0] || null;
}

export async function createUserFromGoogle({ googleSub, email, name, picture }) {
  const res = await query(
    `INSERT INTO users (google_sub, email, name, picture, recall_days)
     VALUES ($1, $2, $3, $4, 30)
     RETURNING *`,
    [googleSub, email, name || null, picture || null]
  );
  return res.rows[0];
}

export async function findUserById(id) {
  const res = await query("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0] || null;
}

export async function updateUserSettings(userId, recallDays) {
  await query("UPDATE users SET recall_days = $1, updated_at = NOW() WHERE id = $2", [
    recallDays,
    userId,
  ]);
}

// Session repository operations
export async function createSession(userId, token, expiresAt) {
  await query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );
}

export async function findSessionWithUser(token) {
  if (!token) return null;
  const res = await query(
    `SELECT s.id as session_id, s.expires_at, u.id, u.google_sub, u.email, u.name, u.picture, u.recall_days, u.created_at
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

export async function deleteSession(token) {
  if (!token) return;
  await query("DELETE FROM sessions WHERE id = $1", [token]);
}

// Journal Entry repository operations
export async function getUserEntries(userId) {
  const res = await query(
    `SELECT id, text, source, flags, entry_date as "date", date_display as "dateDisplay", created_at, updated_at
     FROM journal_entries
     WHERE user_id = $1
     ORDER BY entry_date ASC`,
    [userId]
  );
  return res.rows.map((row) => ({
    ...row,
    date: new Date(row.date || row.entry_date).toISOString(),
    flags: Array.isArray(row.flags) ? row.flags : [],
  }));
}

export async function createJournalEntry(userId, entry) {
  const res = await query(
    `INSERT INTO journal_entries (id, user_id, text, source, flags, entry_date, date_display)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, text, source, flags, entry_date as "date", date_display as "dateDisplay", created_at`,
    [
      entry.id,
      userId,
      entry.text,
      entry.source || "written",
      JSON.stringify(entry.flags || []),
      entry.date,
      entry.dateDisplay || null,
    ]
  );
  const row = res.rows[0];
  return {
    ...row,
    date: new Date(row.date || row.entry_date).toISOString(),
    flags: Array.isArray(row.flags) ? row.flags : [],
  };
}

export async function createJournalEntriesBulk(userId, entries) {
  let added = 0;
  for (const entry of entries) {
    await query(
      `INSERT INTO journal_entries (id, user_id, text, source, flags, entry_date, date_display)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        userId,
        entry.text,
        entry.source || "imported",
        JSON.stringify(entry.flags || []),
        entry.date,
        entry.dateDisplay || null,
      ]
    );
    added++;
  }
  return added;
}

// AI Analyses repository operations
export async function getUserAnalyses(userId) {
  const res = await query(
    `SELECT cache_id, scope, label, recall_days, summary_data, similarities, summary_date
     FROM ai_analyses
     WHERE user_id = $1`,
    [userId]
  );
  const map = {};
  for (const row of res.rows) {
    map[row.cache_id] = {
      cacheId: row.cache_id,
      scope: row.scope,
      label: row.label,
      recallDays: row.recall_days,
      summary: row.summary_data,
      similarities: row.similarities || [],
      summaryDate: new Date(row.summary_date).toISOString(),
    };
  }
  return map;
}

export async function saveAnalysis(userId, payload) {
  await query(
    `INSERT INTO ai_analyses (user_id, cache_id, scope, label, recall_days, summary_data, similarities, summary_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, cache_id) DO UPDATE
     SET summary_data = EXCLUDED.summary_data,
         similarities = EXCLUDED.similarities,
         summary_date = EXCLUDED.summary_date,
         recall_days = EXCLUDED.recall_days`,
    [
      userId,
      payload.cacheId,
      payload.scope,
      payload.label || null,
      payload.recallDays || 30,
      JSON.stringify(payload.summary || {}),
      JSON.stringify(payload.similarities || []),
      payload.summaryDate || new Date().toISOString(),
    ]
  );
}

// Serverless-safe rate limiting in PostgreSQL
export async function checkAndRecordRateLimit(userId, maxRequests = 5, windowSeconds = 60) {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const res = await query(
    `SELECT COUNT(*) as count FROM ai_rate_limits
     WHERE user_id = $1 AND created_at >= $2`,
    [userId, windowStart]
  );
  const currentCount = parseInt(res.rows[0]?.count || "0", 10);
  if (currentCount >= maxRequests) {
    return false;
  }
  await query("INSERT INTO ai_rate_limits (user_id) VALUES ($1)", [userId]);
  return true;
}

// Full account & data deletion (Cascades to all tables)
export async function deleteUserAccount(userId) {
  const res = await query("DELETE FROM users WHERE id = $1", [userId]);
  return res.rowCount > 0;
}
