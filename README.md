# wassup — journal, for you and a few friends

## What this is
- Express backend (`server.js`) that holds your Groq key server-side — it never touches the browser.
- Plain HTML/React frontend (`public/index.html`) — no build step, loads React straight from a CDN.
- Each person who opens the app gets a random id stored in their own browser (`localStorage`), so friends don't see each other's entries. This is NOT real login/auth — anyone who opens the link can write entries. Fine for a small trusted group, not fine beyond that.
- Entries + summaries are stored in `db.json` on the server, a flat file. Fine for a handful of people. If this grows, swap it for a real database (SQLite is the easy next step).

## Run it locally
```bash
npm install
cp .env.example .env
# edit .env: paste your Groq key (from console.groq.com). Default model is openai/gpt-oss-120b.
npm start
```
Then open http://localhost:3000

## Deploy so friends can use it
Any host that runs a Node server works. Two easy free-tier options:

### Render
1. Push this folder to a GitHub repo (private is fine).
2. On render.com: New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables in the Render dashboard (not in a committed .env): `GROQ_API_KEY`, `GROQ_BASE_URL`, `MODEL_NAME`.
5. Deploy. Render gives you a URL like `https://your-app.onrender.com` — share that with friends.

### Railway
Same idea: connect the repo, set the same environment variables in Railway's dashboard, it detects the Node app and gives you a public URL.

**Important:** never put your real API key in a committed file. `.env` is already in `.gitignore`. On whichever host you pick, the key goes into that host's environment variable settings, not into code.

## The honest limitations, so you know what you're testing
- `db.json` is a single file — if two people write at the exact same second there's a tiny race-condition risk. Not a real problem at friends-and-testing scale.
- The "flags" (heavy / craving / conflict) are simple keyword matching, not real detection. Treat them as a highlighter, not a safety system.
- No real auth. Don't put anything in here you wouldn't want visible to someone who guesses the URL and pokes around.
