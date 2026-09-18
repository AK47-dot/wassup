import { MongoClient } from "mongodb";
import crypto from "crypto";

let client = null;
let db = null;

export function getDb() {
  if (db) return db;
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri || !uri.startsWith("mongodb")) {
    return null;
  }

  if (!client) {
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
  }
  db = client.db();
  return db;
}

// Backward-compatibility alias
export function getPool() {
  return getDb();
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// In-memory relational/document store fallback when MONGODB_URI is not configured (e.g. offline testing)
class MemoryDb {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.entries = new Map();
    this.analyses = new Map();
    this.rateLimits = [];
  }

  async findUserByGoogleSub(googleSub) {
    const user = Array.from(this.users.values()).find((u) => u.google_sub === googleSub);
    return user ? { ...user } : null;
  }

  async createUserFromGoogle({ googleSub, email, name, picture }) {
    const id = crypto.randomUUID();
    const user = {
      id,
      google_sub: googleSub,
      email,
      name: name || null,
      picture: picture || null,
      recall_days: 30,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.users.set(id, user);
    return { ...user };
  }

  async findUserById(id) {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async updateUserSettings(userId, recallDays) {
    const user = this.users.get(userId);
    if (user) {
      user.recall_days = recallDays;
      user.updated_at = new Date();
    }
  }

  async createSession(userId, token, expiresAt) {
    const session = {
      id: token,
      user_id: userId,
      expires_at: new Date(expiresAt),
      created_at: new Date(),
    };
    this.sessions.set(token, session);
    return session;
  }

  async findSessionWithUser(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || new Date(session.expires_at) <= new Date()) return null;
    const user = this.users.get(session.user_id);
    if (!user) return null;
    return {
      session_id: session.id,
      expires_at: session.expires_at,
      id: user.id,
      google_sub: user.google_sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      recall_days: user.recall_days || 30,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  async deleteSession(token) {
    if (token) this.sessions.delete(token);
  }

  async getUserEntries(userId) {
    return Array.from(this.entries.values())
      .filter((e) => e.user_id === userId)
      .sort((a, b) => new Date(a.date || a.entry_date) - new Date(b.date || b.entry_date))
      .map((e) => ({
        id: e.id,
        text: e.text,
        source: e.source || "written",
        flags: Array.isArray(e.flags) ? e.flags : [],
        date: new Date(e.date || e.entry_date).toISOString(),
        dateDisplay: e.dateDisplay || e.date_display || null,
        created_at: e.created_at || new Date().toISOString(),
        updated_at: e.updated_at || new Date().toISOString(),
      }));
  }

  async createJournalEntry(userId, entry) {
    const isoDate = new Date(entry.date || Date.now()).toISOString();
    const doc = {
      id: entry.id,
      user_id: userId,
      text: entry.text,
      source: entry.source || "written",
      flags: Array.isArray(entry.flags) ? entry.flags : [],
      entry_date: isoDate,
      date: isoDate,
      date_display: entry.dateDisplay || null,
      dateDisplay: entry.dateDisplay || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.entries.set(entry.id, doc);
    return {
      id: doc.id,
      text: doc.text,
      source: doc.source,
      flags: doc.flags,
      date: doc.date,
      dateDisplay: doc.dateDisplay,
      created_at: doc.created_at,
    };
  }

  async createJournalEntriesBulk(userId, entries) {
    let added = 0;
    for (const e of entries) {
      if (e && e.text) {
        await this.createJournalEntry(userId, e);
        added++;
      }
    }
    return added;
  }

  async getUserAnalyses(userId) {
    const map = {};
    for (const a of this.analyses.values()) {
      if (a.user_id === userId) {
        map[a.cache_id] = {
          cacheId: a.cache_id,
          scope: a.scope,
          label: a.label,
          recallDays: a.recall_days,
          summary: a.summary_data,
          similarities: a.similarities || [],
          summaryDate: new Date(a.summary_date).toISOString(),
        };
      }
    }
    return map;
  }

  async saveAnalysis(userId, payload) {
    const key = `${userId}:${payload.cacheId}`;
    const doc = {
      user_id: userId,
      cache_id: payload.cacheId,
      scope: payload.scope,
      label: payload.label || null,
      recall_days: payload.recallDays || 30,
      summary_data: payload.summary || {},
      similarities: payload.similarities || [],
      summary_date: new Date(payload.summaryDate || Date.now()).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.analyses.set(key, doc);
    return doc;
  }

  async checkAndRecordRateLimit(userId, maxRequests = 5, windowSeconds = 60) {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const count = this.rateLimits.filter((r) => r.user_id === userId && r.created_at >= since).length;
    if (count >= maxRequests) return false;
    this.rateLimits.push({ user_id: userId, created_at: new Date() });
    return true;
  }

  async deleteUserAccount(userId) {
    const existed = this.users.has(userId);
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
    return existed;
  }
}

export const memoryDb = new MemoryDb();

// Generic query router helper if called
export async function query(text, params = []) {
  return { rows: [], rowCount: 0 };
}

export async function initDb() {
  const database = getDb();
  if (!database) {
    return;
  }

  try {
    const users = database.collection("users");
    await users.createIndex({ google_sub: 1 }, { unique: true });
    await users.createIndex({ id: 1 }, { unique: true });

    const sessions = database.collection("sessions");
    await sessions.createIndex({ id: 1 }, { unique: true });
    await sessions.createIndex({ user_id: 1 });
    await sessions.createIndex({ expires_at: 1 });

    const entries = database.collection("journal_entries");
    await entries.createIndex({ user_id: 1, entry_date: 1 });
    await entries.createIndex({ id: 1 }, { unique: true });

    const analyses = database.collection("ai_analyses");
    await analyses.createIndex({ user_id: 1, cache_id: 1 }, { unique: true });

    const rateLimits = database.collection("ai_rate_limits");
    await rateLimits.createIndex({ user_id: 1, created_at: 1 });
  } catch (err) {
    console.error("MongoDB index initialization notice:", err.message);
  }
}

// User repository operations
export async function findUserByGoogleSub(googleSub) {
  const database = getDb();
  if (!database) return memoryDb.findUserByGoogleSub(googleSub);

  const user = await database.collection("users").findOne({ google_sub: googleSub });
  if (!user) return null;
  return {
    id: user.id,
    google_sub: user.google_sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    recall_days: user.recall_days || 30,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function createUserFromGoogle({ googleSub, email, name, picture }) {
  const database = getDb();
  if (!database) return memoryDb.createUserFromGoogle({ googleSub, email, name, picture });

  const id = crypto.randomUUID();
  const user = {
    id,
    google_sub: googleSub,
    email,
    name: name || null,
    picture: picture || null,
    recall_days: 30,
    created_at: new Date(),
    updated_at: new Date(),
  };
  await database.collection("users").insertOne(user);
  return user;
}

export async function findUserById(id) {
  const database = getDb();
  if (!database) return memoryDb.findUserById(id);

  const user = await database.collection("users").findOne({ id });
  if (!user) return null;
  return {
    id: user.id,
    google_sub: user.google_sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    recall_days: user.recall_days || 30,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function updateUserSettings(userId, recallDays) {
  const database = getDb();
  if (!database) return memoryDb.updateUserSettings(userId, recallDays);

  await database.collection("users").updateOne(
    { id: userId },
    { $set: { recall_days: recallDays, updated_at: new Date() } }
  );
}

// Session repository operations
export async function createSession(userId, token, expiresAt) {
  const database = getDb();
  if (!database) return memoryDb.createSession(userId, token, expiresAt);

  await database.collection("sessions").insertOne({
    id: token,
    user_id: userId,
    expires_at: new Date(expiresAt),
    created_at: new Date(),
  });
}

export async function findSessionWithUser(token) {
  if (!token) return null;
  const database = getDb();
  if (!database) return memoryDb.findSessionWithUser(token);

  const session = await database.collection("sessions").findOne({
    id: token,
    expires_at: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await database.collection("users").findOne({ id: session.user_id });
  if (!user) return null;

  return {
    session_id: session.id,
    expires_at: session.expires_at,
    id: user.id,
    google_sub: user.google_sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    recall_days: user.recall_days || 30,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function deleteSession(token) {
  if (!token) return;
  const database = getDb();
  if (!database) return memoryDb.deleteSession(token);

  await database.collection("sessions").deleteOne({ id: token });
}

// Journal Entry repository operations
export async function getUserEntries(userId) {
  const database = getDb();
  if (!database) return memoryDb.getUserEntries(userId);

  const entries = await database
    .collection("journal_entries")
    .find({ user_id: userId })
    .sort({ entry_date: 1 })
    .toArray();

  return entries.map((doc) => ({
    id: doc.id,
    text: doc.text,
    source: doc.source || "written",
    flags: Array.isArray(doc.flags) ? doc.flags : [],
    date: new Date(doc.entry_date).toISOString(),
    dateDisplay: doc.date_display || null,
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : new Date().toISOString(),
    updated_at: doc.updated_at ? new Date(doc.updated_at).toISOString() : new Date().toISOString(),
  }));
}

export async function createJournalEntry(userId, entry) {
  const database = getDb();
  if (!database) return memoryDb.createJournalEntry(userId, entry);

  const isoDate = new Date(entry.date || Date.now());
  const doc = {
    id: entry.id,
    user_id: userId,
    text: entry.text,
    source: entry.source || "written",
    flags: Array.isArray(entry.flags) ? entry.flags : [],
    entry_date: isoDate,
    date_display: entry.dateDisplay || null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  await database.collection("journal_entries").insertOne(doc);
  return {
    id: doc.id,
    text: doc.text,
    source: doc.source,
    flags: doc.flags,
    date: doc.entry_date.toISOString(),
    dateDisplay: doc.date_display,
    created_at: doc.created_at.toISOString(),
  };
}

export async function createJournalEntriesBulk(userId, entries) {
  if (!entries || entries.length === 0) return 0;
  const database = getDb();
  if (!database) return memoryDb.createJournalEntriesBulk(userId, entries);

  const docs = entries
    .filter((e) => e && e.text)
    .map((entry) => ({
      id: entry.id,
      user_id: userId,
      text: entry.text,
      source: entry.source || "imported",
      flags: Array.isArray(entry.flags) ? entry.flags : [],
      entry_date: new Date(entry.date || Date.now()),
      date_display: entry.dateDisplay || null,
      created_at: new Date(),
      updated_at: new Date(),
    }));

  if (docs.length === 0) return 0;
  const res = await database.collection("journal_entries").insertMany(docs, { ordered: false });
  return res.insertedCount || docs.length;
}

// AI Analyses repository operations
export async function getUserAnalyses(userId) {
  const database = getDb();
  if (!database) return memoryDb.getUserAnalyses(userId);

  const list = await database.collection("ai_analyses").find({ user_id: userId }).toArray();
  const map = {};
  for (const doc of list) {
    map[doc.cache_id] = {
      cacheId: doc.cache_id,
      scope: doc.scope,
      label: doc.label,
      recallDays: doc.recall_days,
      summary: doc.summary_data,
      similarities: doc.similarities || [],
      summaryDate: new Date(doc.summary_date).toISOString(),
    };
  }
  return map;
}

export async function saveAnalysis(userId, payload) {
  const database = getDb();
  if (!database) return memoryDb.saveAnalysis(userId, payload);

  const summaryDate = new Date(payload.summaryDate || Date.now());
  await database.collection("ai_analyses").updateOne(
    { user_id: userId, cache_id: payload.cacheId },
    {
      $set: {
        scope: payload.scope,
        label: payload.label || null,
        recall_days: payload.recallDays || 30,
        summary_data: payload.summary || {},
        similarities: payload.similarities || [],
        summary_date: summaryDate,
        updated_at: new Date(),
      },
      $setOnInsert: {
        user_id: userId,
        cache_id: payload.cacheId,
        created_at: new Date(),
      },
    },
    { upsert: true }
  );
}

// Serverless-safe AI Rate Limiting in MongoDB
export async function checkAndRecordRateLimit(userId, maxRequests = 5, windowSeconds = 60) {
  const database = getDb();
  if (!database) return memoryDb.checkAndRecordRateLimit(userId, maxRequests, windowSeconds);

  const windowStart = new Date(Date.now() - windowSeconds * 1000);
  const count = await database.collection("ai_rate_limits").countDocuments({
    user_id: userId,
    created_at: { $gte: windowStart },
  });

  if (count >= maxRequests) {
    return false;
  }

  await database.collection("ai_rate_limits").insertOne({
    user_id: userId,
    created_at: new Date(),
  });
  return true;
}

// Full account & data deletion (Cascades to all collections)
export async function deleteUserAccount(userId) {
  const database = getDb();
  if (!database) return memoryDb.deleteUserAccount(userId);

  const res = await database.collection("users").deleteOne({ id: userId });
  await Promise.all([
    database.collection("sessions").deleteMany({ user_id: userId }),
    database.collection("journal_entries").deleteMany({ user_id: userId }),
    database.collection("ai_analyses").deleteMany({ user_id: userId }),
    database.collection("ai_rate_limits").deleteMany({ user_id: userId }),
  ]);
  return res.deletedCount > 0;
}
