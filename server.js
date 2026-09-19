import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";
import {
  initDb,
  findUserByGoogleSub,
  createUserFromGoogle,
  findUserById,
  updateUserSettings,
  createSession,
  findSessionWithUser,
  deleteSession,
  getUserEntries,
  createJournalEntry,
  createJournalEntriesBulk,
  getUserAnalyses,
  saveAnalysis,
  checkAndRecordRateLimit,
  deleteUserAccount,
} from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const MODEL_NAME = process.env.MODEL_NAME || "openai/gpt-oss-120b";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const MAX_JOURNAL_CHARS = 70000;
const MAX_SIMILARITIES = 3;

// Initialize DB schema on startup
initDb().catch((err) => {
  console.error("Database initialization notice:", err.message);
});

export const app = express();

// --- Production security headers & CSP ------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' https://accounts.google.com https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://accounts.google.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com;"
  );
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: ["text/plain"], limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Helper Date/Time formatters -----------------------------------------
function getOffsetMinutes(req) {
  const raw = req.headers["x-timezone-offset"];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function dayKeyFromIso(iso, offsetMin) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() - offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayTitle(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatTime(iso, offsetMin) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - offsetMin * 60000);
  let h = local.getUTCHours();
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

function startOfWeekKey(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + mondayOffset);
  return dt.toISOString().slice(0, 10);
}

function startOfMonthKey(dayKey) {
  return dayKey.slice(0, 8) + "01";
}

function todayKey(offsetMin) {
  return dayKeyFromIso(new Date().toISOString(), offsetMin);
}

function inRange(dayKey, startKey, endKey) {
  return dayKey >= startKey && dayKey <= endKey;
}

function daysAgoKey(fromKey, days) {
  const [y, m, d] = fromKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function annotate(entries, offsetMin) {
  return entries.map((e) => ({
    ...e,
    dayKey: dayKeyFromIso(e.date, offsetMin),
    timeDisplay: formatTime(e.date, offsetMin),
  }));
}

function filterByDay(entries, dayKey) {
  return entries
    .filter((e) => e.dayKey === dayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function filterByDayRange(entries, startKey, endKey) {
  return entries
    .filter((e) => e.dayKey && inRange(e.dayKey, startKey, endKey))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function clampRecallDays(n) {
  const d = Number(n);
  if (!Number.isFinite(d) || d < 1) return 30;
  return Math.min(Math.round(d), 3650);
}

function formatEntryBlock(e) {
  const day = e.dayKey ? formatDayTitle(e.dayKey) : e.dateDisplay || e.date;
  const time = e.timeDisplay || "";
  return `[${day}${time ? " · " + time : ""}] id=${e.id}\n${e.text}`;
}

function packEntries(list, maxChars) {
  const out = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const block = formatEntryBlock(list[i]);
    if (used + block.length > maxChars && out.length) break;
    out.push(list[i]);
    used += block.length + 8;
  }
  return out.reverse();
}

function renderJournal(list) {
  return list.map(formatEntryBlock).join("\n\n---\n\n");
}

function exportAsText(entries, offsetMin) {
  const annotated = annotate(entries, offsetMin)
    .filter((e) => e.dayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  const days = [];
  const byDay = {};
  for (const e of annotated) {
    if (!byDay[e.dayKey]) {
      byDay[e.dayKey] = [];
      days.push(e.dayKey);
    }
    byDay[e.dayKey].push(e);
  }
  return days
    .map((key) => {
      const header = `DATE: ${formatDayTitle(key)}`;
      const body = byDay[key]
        .map((e) => `${e.timeDisplay}\n${e.text.trim()}`)
        .join("\n\n");
      return `${header}\n\n${body}`;
    })
    .join("\n\n--------------------------------\n\n");
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseDateLine(line) {
  const cleaned = line.replace(/^DATE:\s*/i, "").trim();
  const m = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeLine(line) {
  const t = line.trim();
  let m = t.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return { h, min };
  }
  m = t.match(/^(\d{1,2})\s*([AaPp][Mm])$/);
  if (m) {
    let h = Number(m[1]);
    const ap = m[2].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return { h, min: 0 };
  }
  m = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (m) return { h: Number(m[1]), min: Number(m[2]) };
  return null;
}

function isoFromLocal(dayKey, h, min, offsetMin) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, h, min, 0) + offsetMin * 60000;
  return new Date(utcMs).toISOString();
}

export function parseJournalText(raw, offsetMin = 0) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  let currentDay = null;
  let currentTime = { h: 12, min: 0 };
  let buf = [];

  function flush() {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text || !currentDay) return;
    items.push({
      text,
      date: isoFromLocal(currentDay, currentTime.h, currentTime.min, offsetMin),
    });
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{3,}$/.test(trimmed)) {
      flush();
      continue;
    }
    const dateKey = parseDateLine(trimmed);
    if (dateKey && (/^DATE:/i.test(trimmed) || MONTHS[trimmed.split(/\s+/)[0].toLowerCase()])) {
      flush();
      currentDay = dateKey;
      currentTime = { h: 12, min: 0 };
      continue;
    }
    const time = parseTimeLine(trimmed);
    if (time && currentDay) {
      flush();
      currentTime = time;
      continue;
    }
    buf.push(line);
  }
  flush();
  return items;
}

function makeEntry(text, date, source, suffix) {
  const when = date ? new Date(date) : new Date();
  const safe = Number.isNaN(when.getTime()) ? new Date() : when;
  return {
    id: Date.now() + "-" + (suffix != null ? suffix + "-" : "") + Math.random().toString(36).slice(2, 8),
    text: String(text).trim(),
    source: source === "imported" ? "imported" : "written",
    flags: flagEntry(text),
    date: safe.toISOString(),
    dateDisplay: safe.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }),
  };
}

const FLAG_PATTERNS = [
  { tag: "heavy", re: /\b(want(ed)? to die|kill myself|end it all|no reason to (live|go on)|self[- ]?harm|hurt myself|can'?t (take|do) this anymore)\b/i },
  { tag: "craving", re: /\b(relapse|relapsed|craving|urge to (smoke|drink|use))\b/i },
  { tag: "conflict", re: /\b(fight|fought|yelled|screamed|blew up|argument)\b/i },
];
function flagEntry(text) {
  return FLAG_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.tag);
}

const FRIEND_VOICE = `You are reading someone's personal journal. You are not a therapist, not a coach, not an app. You are a close friend with a very good memory who has read what they wrote and noticed things they might not have noticed themselves.

Be specific. Use their own words, names, habits, and places. Never generic self-help language. Never prescriptive "you should" advice framed like a wellness app. If you have a suggestion, phrase it the way a friend would say it over chai.

Return ONLY valid JSON, nothing else.`;

function systemPromptFor(scope) {
  const similarityRules = `similarities: 0–${MAX_SIMILARITIES} objects. Only include a similarity if it is genuinely meaningful — same recurring behavior, emotion, situation, person, contradiction, progress, or regression — even if the wording is different. Do NOT keyword-match. If nothing is genuinely related, return []. Each object:
  { "entryId": "the id= value from a previous entry", "when": "human date", "quote": "short paraphrase or brief quote from the older entry", "why": "one sentence on why this is similar / what changed" }`;

  if (scope === "entry") {
    return `${FRIEND_VOICE}

You are looking at ONE timestamped moment. Summarize what is actually happening in that entry. Do not invent a whole-day story.

JSON shape:
{
  "happening": ["1-2 sentences to the person"],
  "worth_noticing": ["optional, one gentle observation max"],
  "advice": [],
  "repeated": [],
  "new_this_period": [],
  "similarities": []
}

${similarityRules}
Each string 1-2 sentences, written to "you". Empty arrays are better than padding.`;
  }

  if (scope === "day") {
    return `${FRIEND_VOICE}

You are looking at ONE calendar day with multiple timestamps. Read them in order. Notice how the day progressed — mood shifts, contradictions between morning and night, things that got resolved or didn't. Do not treat the timestamps as unrelated scraps.

JSON shape:
{
  "happening": ["how the day actually went, in order"],
  "repeated": ["patterns inside this day, if any"],
  "new_this_period": ["what shifted during the day"],
  "worth_noticing": ["one or two gentle observations"],
  "advice": ["optional, one friend-voiced suggestion max"],
  "similarities": []
}

${similarityRules}
Each string 1-2 sentences, written to "you". Empty arrays are better than padding.`;
  }

  return `${FRIEND_VOICE}

You are looking at a stretch of days (a week or a month). This is higher-level than a single day. Identify what has been happening, recurring themes, repeated behaviors, emotional patterns, new developments, changes over time, problems that keep returning, and positive developments. Give useful observations and practical advice in a friend's voice.

JSON shape:
{
  "happening": ["what this period has actually been about"],
  "repeated": ["recurring themes / behaviors / problems"],
  "new_this_period": ["new developments or changes"],
  "worth_noticing": ["gentle, specific observations"],
  "advice": ["practical, friend-voiced, one or two max"],
  "similarities": []
}

${similarityRules}
Each string 1-2 sentences, written to "you". 2-4 items per array max. Empty arrays are better than padding.`;
}

async function callModel(messages) {
  const r = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error(`Groq error ${r.status}: ${t.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const data = await r.json();
  let raw = data.choices?.[0]?.message?.content || "";
  raw = raw.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(raw);
}

function normalizeAnalysis(parsed) {
  const strArr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : []);
  const similarities = (Array.isArray(parsed.similarities) ? parsed.similarities : [])
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      entryId: String(s.entryId || "").trim(),
      when: String(s.when || "").trim(),
      quote: String(s.quote || "").trim(),
      why: String(s.why || "").trim(),
    }))
    .filter((s) => s.why && (s.quote || s.when))
    .slice(0, MAX_SIMILARITIES);
  return {
    happening: strArr(parsed.happening),
    repeated: strArr(parsed.repeated),
    new_this_period: strArr(parsed.new_this_period),
    worth_noticing: strArr(parsed.worth_noticing),
    advice: strArr(parsed.advice),
    similarities,
  };
}

function analysisKey(scope, id) {
  return `${scope}:${id}`;
}

// --- Authentication Middleware (Session Cookie / Bearer Token) ----------
export async function authenticate(req, res, next) {
  const authCookie = req.cookies && req.cookies["wassup_session"];
  const authHeader = req.headers["authorization"] || "";
  const token = authCookie || (authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null);

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Please sign in." });
  }

  try {
    const sessionUser = await findSessionWithUser(token);
    if (!sessionUser) {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
    }
    req.user = sessionUser;
    req.sessionToken = token;
    next();
  } catch (err) {
    console.error("Auth verification error:", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

// --- Serverless-Safe Rate Limiter Middleware -----------------------------
async function rateLimitAnalyze(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const allowed = await checkAndRecordRateLimit(req.user.id, 5, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute before analyzing again." });
  }
  next();
}

// --- Authentication Endpoints --------------------------------------------

// Google Sign-In verification endpoint
app.post("/api/auth/google", async (req, res) => {
  const { credential, testSub, testEmail, testName, testPicture } = req.body || {};

  try {
    let googleSub, email, name, picture;

    // Support local test mock credentials if in test mode
    if (process.env.NODE_ENV === "test" && testSub) {
      googleSub = testSub;
      email = testEmail || `${testSub}@test.local`;
      name = testName || "Test User";
      picture = testPicture || null;
    } else {
      if (!credential || typeof credential !== "string") {
        return res.status(400).json({ error: "Google credential token required." });
      }

      if (!GOOGLE_CLIENT_ID) {
        return res.status(500).json({ error: "Server missing GOOGLE_CLIENT_ID configuration." });
      }

      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub || !payload.email) {
        return res.status(400).json({ error: "Invalid Google token payload." });
      }

      googleSub = payload.sub;
      email = payload.email;
      name = payload.name;
      picture = payload.picture;
    }

    // Lookup or create user in PostgreSQL
    let user = await findUserByGoogleSub(googleSub);
    if (!user) {
      user = await createUserFromGoogle({ googleSub, email, name, picture });
    }

    // Create a 30-day session token
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createSession(user.id, sessionToken, expiresAt);

    // Set secure HttpOnly cookie
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("wassup_session", sessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        recallDays: user.recall_days,
      },
      token: sessionToken,
    });
  } catch (err) {
    console.error("Google authentication error:", err.message);
    res.status(401).json({ error: "Google sign in verification failed." });
  }
});

// --- Quick email-only sign-in (test run, no Google needed) ---------------
app.post("/api/auth/email", async (req, res) => {
  const { email, name } = req.body || {};
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  try {
    const pseudoSub = `email:${trimmed}`;
    let user = await findUserByGoogleSub(pseudoSub);
    if (!user) {
      user = await createUserFromGoogle({
        googleSub: pseudoSub,
        email: trimmed,
        name: (name && String(name).trim()) || trimmed.split("@")[0],
        picture: null,
      });
    }

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createSession(user.id, sessionToken, expiresAt);

    res.cookie("wassup_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.json({
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, recallDays: user.recall_days },
      token: sessionToken,
    });
  } catch (err) {
    console.error("Email sign-in error:", err.message);
    res.status(500).json({ error: "Sign-in failed." });
  }
});

app.get("/api/config", (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || "",
  });
});
// Current User Profile check
app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      recallDays: req.user.recall_days,
    },
    googleClientId: GOOGLE_CLIENT_ID || "",
  });
});

// Logout
app.post("/api/auth/logout", authenticate, async (req, res) => {
  if (req.sessionToken) {
    await deleteSession(req.sessionToken);
  }
  res.clearCookie("wassup_session", { path: "/" });
  res.json({ success: true });
});

// Delete Account & Cascading User Data
app.delete("/api/account", authenticate, async (req, res) => {
  await deleteUserAccount(req.user.id);
  res.clearCookie("wassup_session", { path: "/" });
  res.json({ success: true, message: "Account and all associated data permanently deleted." });
});

// --- Journal API Endpoints (Strictly scoped to req.user.id) ---------------

app.get("/api/entries", authenticate, async (req, res) => {
  try {
    const rawEntries = await getUserEntries(req.user.id);
    const analyses = await getUserAnalyses(req.user.id);
    const offset = getOffsetMinutes(req);
    const entries = annotate(rawEntries, offset);

    res.json({
      entries,
      settings: { recallDays: req.user.recall_days || 30 },
      analyses,
    });
  } catch (err) {
    console.error("Error fetching user entries:", err.message);
    res.status(500).json({ error: "Failed to fetch entries." });
  }
});

app.post("/api/settings", authenticate, async (req, res) => {
  const rawRecall = req.body && req.body.recallDays;
  if (rawRecall !== undefined && typeof rawRecall !== "number") {
    return res.status(400).json({ error: "recallDays must be a number" });
  }
  const recallDays = clampRecallDays(rawRecall);
  await updateUserSettings(req.user.id, recallDays);
  req.user.recall_days = recallDays;
  res.json({ settings: { recallDays } });
});

app.post("/api/entries", authenticate, async (req, res) => {
  const { text, source, date } = req.body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text required" });
  }
  if (text.length > 50000) {
    return res.status(400).json({ error: "Text entry exceeds length limit of 50k characters." });
  }

  const entry = makeEntry(text, date, source);
  const created = await createJournalEntry(req.user.id, entry);
  const offset = getOffsetMinutes(req);
  res.json({ entry: annotate([created], offset)[0] });
});

app.post("/api/entries/bulk", authenticate, async (req, res) => {
  const body = req.body || {};
  let items = [];
  if (Array.isArray(body.items)) {
    items = body.items;
  } else if (Array.isArray(body.texts)) {
    items = body.texts.map((t) => ({ text: t, date: new Date().toISOString() }));
  }
  if (items.length === 0) return res.status(400).json({ error: "texts or items required" });
  if (items.length > 200) return res.status(400).json({ error: "Bulk import limit is 200 entries at a time." });

  const entriesToInsert = items
    .slice(0, 200)
    .map((item, i) => {
      const text = typeof item === "string" ? item : item.text;
      const date = typeof item === "string" ? undefined : item.date;
      if (typeof text !== "string" || text.length > 50000) return null;
      return makeEntry(text, date, "imported", i);
    })
    .filter((e) => e && e.text);

  const added = await createJournalEntriesBulk(req.user.id, entriesToInsert);
  res.json({ added });
});

app.post("/api/import/text", authenticate, async (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body && req.body.text) || "";
  if (typeof raw !== "string") {
    return res.status(400).json({ error: "Invalid text payload" });
  }
  if (raw.length > 500000) {
    return res.status(400).json({ error: "Text payload exceeds bulk text limit of 500k characters." });
  }

  const offset = getOffsetMinutes(req);
  const items = parseJournalText(raw, offset);
  if (items.length === 0) {
    return res.status(400).json({ error: "Couldn't find dates and entries in that text." });
  }
  const entriesToInsert = items
    .slice(0, 500)
    .map((item, i) => makeEntry(item.text, item.date, "imported", i));
  const added = await createJournalEntriesBulk(req.user.id, entriesToInsert);
  res.json({ added });
});

app.get("/api/export.txt", authenticate, async (req, res) => {
  const rawEntries = await getUserEntries(req.user.id);
  const offset = getOffsetMinutes(req);
  const text = exportAsText(rawEntries, offset);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="journal.txt"');
  res.send(text || "No entries yet.\n");
});

app.get("/api/export.json", authenticate, async (req, res) => {
  const rawEntries = await getUserEntries(req.user.id);
  const offset = getOffsetMinutes(req);
  res.json({ entries: annotate(rawEntries, offset) });
});

// --- AI Analysis Core ----------------------------------------------------
async function analyzeUser(req, res, body) {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY. Set it in .env." });
  }

  const rawEntries = await getUserEntries(req.user.id);
  const offset = getOffsetMinutes(req);
  const all = annotate(rawEntries, offset).filter((e) => e.dayKey);
  if (all.length === 0) return res.status(400).json({ error: "No entries yet." });

  const recallDays = clampRecallDays(
    (body && body.recallDays) != null ? body.recallDays : req.user.recall_days
  );
  const today = todayKey(offset);
  const recallStart = daysAgoKey(today, recallDays);
  const scope = (body && body.scope) || "period";

  let focus = [];
  let cacheId = "period:month";
  let label = "this month";

  if (scope === "entry") {
    const entry = all.find((e) => e.id === body.entryId);
    if (!entry) return res.status(404).json({ error: "Entry not found." });
    focus = [entry];
    cacheId = analysisKey("entry", entry.id);
    label = `${formatDayTitle(entry.dayKey)} · ${entry.timeDisplay}`;
  } else if (scope === "day") {
    const dayKey = body.dayKey;
    if (!dayKey) return res.status(400).json({ error: "dayKey required" });
    focus = filterByDay(all, dayKey);
    if (focus.length === 0) return res.status(400).json({ error: "No entries that day." });
    cacheId = analysisKey("day", dayKey);
    label = formatDayTitle(dayKey);
  } else {
    const period = body.period === "week" ? "week" : "month";
    const start = period === "week" ? startOfWeekKey(today) : startOfMonthKey(today);
    focus = filterByDayRange(all, start, today);
    if (focus.length === 0) {
      return res.status(400).json({ error: `Nothing written ${period === "week" ? "this week" : "this month"} yet.` });
    }
    cacheId = analysisKey("period", period);
    label = period === "week" ? "this week" : "this month";
  }

  const focusIds = new Set(focus.map((e) => e.id));
  const prior = all.filter((e) => !focusIds.has(e.id) && e.dayKey >= recallStart && e.dayKey <= today);
  const packedFocus = packEntries(focus, Math.floor(MAX_JOURNAL_CHARS * 0.55));
  const packedPrior = packEntries(prior, Math.floor(MAX_JOURNAL_CHARS * 0.45));

  const userContent = [
    `Scope: ${scope} (${label}).`,
    `Look back through previous entries from ${formatDayTitle(recallStart)} to now (${recallDays} days).`,
    "",
    "=== ENTRIES TO ANALYZE ===",
    renderJournal(packedFocus),
    "",
    packedPrior.length
      ? "=== PREVIOUS ENTRIES FOR RECALL (use only if genuinely related) ===\n" + renderJournal(packedPrior)
      : "=== PREVIOUS ENTRIES FOR RECALL ===\nNone in the selected look-back period.",
  ].join("\n");

  try {
    const parsed = await callModel([
      { role: "system", content: systemPromptFor(scope) },
      { role: "user", content: userContent },
    ]);
    const analysis = normalizeAnalysis(parsed);
    analysis.similarities = analysis.similarities.map((s) => {
      const match = packedPrior.find((e) => e.id === s.entryId);
      return {
        ...s,
        when: s.when || (match ? `${formatDayTitle(match.dayKey)} · ${match.timeDisplay}` : ""),
        dayKey: match ? match.dayKey : undefined,
        entryId: match ? match.id : s.entryId,
      };
    });

    const payload = {
      summary: analysis,
      similarities: analysis.similarities,
      summaryDate: new Date().toISOString(),
      scope,
      cacheId,
      label,
      recallDays,
    };

    await saveAnalysis(req.user.id, payload);
    res.json(payload);
  } catch (err) {
    if (err.status === 502) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: "Couldn't generate summary." });
  }
}

app.post("/api/analyze", authenticate, rateLimitAnalyze, (req, res) => analyzeUser(req, res, req.body || {}));

app.post("/api/summarize", authenticate, rateLimitAnalyze, (req, res) => {
  const body = req.body || {};
  return analyzeUser(req, res, {
    scope: body.scope || "period",
    period: body.period || "month",
    dayKey: body.dayKey,
    entryId: body.entryId,
    recallDays: body.recallDays,
  });
});

// --- Generic production error handler (Hides stack traces) ---------------
app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err.message);
  res.status(500).json({ error: "An unexpected error occurred. Please try again later." });
});

const isMain = process.argv[1] && (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server"));
if (isMain && process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Wassup Journal running on http://localhost:${PORT}`);
  });
}
export default app;