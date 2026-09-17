// Comprehensive PostgreSQL & Google Auth Multi-User Security Regression Test Suite
import { app } from "./server.js";
import http from "http";

let server = null;
const PORT = 3099;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);

function extractCookie(res) {
  if (typeof res.headers.getSetCookie === "function") {
    const cookies = res.headers.getSetCookie();
    for (const c of cookies) {
      const match = c.match(/wassup_session=([^;]+)/);
      if (match) return `wassup_session=${match[1]}`;
    }
  }
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(/wassup_session=([^;]+)/);
  return match ? `wassup_session=${match[1]}` : "";
}

async function runTests() {
  console.log("===============================================================");
  console.log("  WASSUP JOURNAL — MULTI-USER SECURITY & REGRESSION TEST SUITE ");
  console.log("===============================================================\n");

  await new Promise((resolve) => {
    server = http.createServer(app).listen(PORT, "127.0.0.1", resolve);
  });

  let allPassed = true;

  function assert(condition, testName) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
    } else {
      console.error(`[FAIL] ${testName}`);
      allPassed = false;
    }
  }

  try {
    // --- 1. Authentication Tests ---
    console.log("--- 1. Authentication & Session Verification ---");

    // 1.1 Unauthenticated requests are rejected
    const unauthRes = await fetch(`${baseUrl}/api/entries`);
    assert(unauthRes.status === 401, "Unauthenticated GET /api/entries returns 401");

    // 1.2 User A Google Authentication (Mock verified payload in test mode)
    const googleSubA = "google-sub-user-A-" + Date.now();
    const loginARes = await fetch(`${baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testSub: googleSubA,
        testEmail: "usera@example.com",
        testName: "User Alpha",
      }),
    });
    assert(loginARes.status === 200, "User A Google sign-in returns 200");
    const cookieA = extractCookie(loginARes);
    assert(Boolean(cookieA), "User A received secure wassup_session cookie");

    // 1.3 User B Google Authentication
    const googleSubB = "google-sub-user-B-" + Date.now();
    const loginBRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testSub: googleSubB,
        testEmail: "userb@example.com",
        testName: "User Beta",
      }),
    });
    assert(loginBRes.status === 200, "User B Google sign-in returns 200");
    const cookieB = extractCookie(loginBRes);
    assert(Boolean(cookieB), "User B received secure wassup_session cookie");
    assert(cookieA !== cookieB, "User A and User B received distinct session cookies");

    // 1.4 Profile /me check
    const meARes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieA },
    });
    const meAData = await meARes.json();
    assert(meAData.user?.email === "usera@example.com", "GET /api/auth/me returns User A profile");

    // --- 2. Multi-User Isolation & IDOR Protection ---
    console.log("\n--- 2. Multi-User Data Isolation & IDOR Protection ---");

    // 2.1 User A creates an entry
    const entryARes = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "User A private thoughts about college." }),
    });
    const entryAData = await entryARes.json();
    assert(entryARes.status === 200 && entryAData.entry?.text?.includes("User A"), "User A created entry successfully");

    // 2.2 User B creates an entry
    const entryBRes = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { Cookie: cookieB, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "User B private confidential work notes." }),
    });
    const entryBData = await entryBRes.json();
    assert(entryBRes.status === 200 && entryBData.entry?.text?.includes("User B"), "User B created entry successfully");

    // 2.3 User A reads entries - MUST NOT see User B entries
    const listARes = await fetch(`${baseUrl}/api/entries`, {
      headers: { Cookie: cookieA },
    });
    const listAData = await listARes.json();
    const hasA = listAData.entries.some((e) => e.text.includes("User A"));
    const hasBInA = listAData.entries.some((e) => e.text.includes("User B"));
    assert(hasA && !hasBInA, "User A GET /api/entries sees only User A entries and NO User B entries");

    // 2.4 User B reads entries - MUST NOT see User A entries
    const listBRes = await fetch(`${baseUrl}/api/entries`, {
      headers: { Cookie: cookieB },
    });
    const listBData = await listBRes.json();
    const hasB = listBData.entries.some((e) => e.text.includes("User B"));
    const hasAInB = listBData.entries.some((e) => e.text.includes("User A"));
    assert(hasB && !hasAInB, "User B GET /api/entries sees only User B entries and NO User A entries");

    // 2.5 Export isolation - User A export contains only User A data
    const exportARes = await fetch(`${baseUrl}/api/export.txt`, {
      headers: { Cookie: cookieA },
    });
    const exportAText = await exportARes.text();
    assert(exportAText.includes("User A") && !exportAText.includes("User B"), "GET /api/export.txt for User A contains zero User B records");

    // --- 3. Input Validation & Body Limits ---
    console.log("\n--- 3. Input Validation & Body Size Limits ---");

    // 3.1 Oversized entry (> 50,000 characters)
    const hugeText = "X".repeat(50001);
    const oversizedRes = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ text: hugeText }),
    });
    assert(oversizedRes.status === 400, "Oversized journal entry (>50k chars) rejected with 400");

    // 3.2 SQL Injection attempt in text content
    const sqliText = "'; DROP TABLE journal_entries; --";
    const sqliRes = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ text: sqliText }),
    });
    assert(sqliRes.status === 200, "SQL injection string safely stored as literal text via parameterization");

    // --- 4. AI Rate Limiting ---
    console.log("\n--- 4. Serverless-Safe AI Rate Limiting ---");

    // Trigger AI calls until rate limit trips (max 5/min)
    let hitRateLimit = false;
    for (let i = 0; i < 7; i++) {
      const aiRes = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { Cookie: cookieA, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "period", period: "month" }),
      });
      if (aiRes.status === 429) {
        hitRateLimit = true;
        break;
      }
    }
    assert(hitRateLimit, "AI endpoint rate limiter triggered 429 after 5 requests/minute");

    // --- 5. Account Deletion & Cascading Clean-up ---
    console.log("\n--- 5. Account Deletion & Cascading Clean-up ---");

    // 5.1 Delete User A
    const deleteARes = await fetch(`${baseUrl}/api/account`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    assert(deleteARes.status === 200, "DELETE /api/account for User A returns 200");

    // 5.2 Verify User A session is dead
    const deadSessionRes = await fetch(`${baseUrl}/api/entries`, {
      headers: { Cookie: cookieA },
    });
    const deadBody = await deadSessionRes.text();
    console.log("deadSessionRes result:", deadSessionRes.status, deadBody);
    assert(deadSessionRes.status === 401, "User A session invalidated immediately upon account deletion (401)");

    // 5.3 Verify User B data is completely untouched
    const verifyBRes = await fetch(`${baseUrl}/api/entries`, {
      headers: { Cookie: cookieB },
    });
    const verifyBData = await verifyBRes.json();
    assert(verifyBData.entries.length === 1 && verifyBData.entries[0].text.includes("User B"), "User B data remains completely intact after User A deletion");

    // --- 6. Static File & Secret Protection ---
    console.log("\n--- 6. Static File & Secret Protection ---");
    const dbFileRes = await fetch(`${baseUrl}/db.json`);
    assert(dbFileRes.status === 404, "Static request to /db.json returns 404 Not Found");

    const envFileRes = await fetch(`${baseUrl}/.env`);
    assert(envFileRes.status === 404, "Static request to /.env returns 404 Not Found");

    console.log("\n===============================================================");
    if (allPassed) {
      console.log("  ALL TESTS PASSED: APPLICATION IS HARDENED & MULTI-USER SAFE ");
    } else {
      console.error("  SOME TESTS FAILED! CHECK OUTPUT ABOVE ");
    }
    console.log("===============================================================\n");
  } catch (err) {
    console.error("Unexpected error during test execution:", err);
    allPassed = false;
  } finally {
    if (server) {
      server.close();
    }
    process.exit(allPassed ? 0 : 1);
  }
}

runTests();
