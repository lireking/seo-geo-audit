// ─────────────────────────────────────────────────────────────────────────────
// One-time OAuth: mint a long-lived GSC refresh token so gsc-fetch can run
// headless as YOU (the property owner) — no service account added to GSC.
//
// Use this when org policy blocks adding a service-account email in Search
// Console. Runs the OAuth "installed app" loopback flow (dependency-free,
// node:http): opens a local server, you authorize in the browser, Google
// redirects back to localhost with a code, we exchange it for a refresh token
// and append it to .env.local.
//
//   node gsc-fetch/gsc-auth.mjs
//
// SETUP (Google side, ~2 min):
//   1. Google Cloud Console → APIs & Services → enable "Google Search Console API"
//   2. → Credentials → Create credentials → OAuth client ID → type "Desktop app"
//      (if asked, configure the consent screen: External, add yourself as a Test
//       user — that's enough, no verification/publishing needed for your own use)
//   3. Copy the Client ID + Client secret into .env.local:
//        GSC_OAUTH_CLIENT_ID=...apps.googleusercontent.com
//        GSC_OAUTH_CLIENT_SECRET=...
//   4. Run this script, authorize in the browser with the Google account that
//      OWNS the GSC property.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from "node:http";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

// load .env.local (dependency-free)
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const CLIENT_ID = process.env.GSC_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GSC_OAUTH_CLIENT_SECRET;
const PORT = Number(process.env.GSC_OAUTH_PORT || 4180);
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "✖ GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET not set in .env.local.\n" +
      "  Create an OAuth client (type 'Desktop app') in Google Cloud Console first —\n" +
      "  see the SETUP block at the top of this file."
  );
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force a fresh refresh token even on re-auth
  });

console.log("\n▶ Open this URL in your browser and authorize:\n\n" + authUrl + "\n");
console.log(`  (waiting for the redirect to ${REDIRECT} …)\n`);

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    const c = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    if (err) {
      res.end(`Auth error: ${err}. Return to the terminal.`);
      server.close();
      reject(new Error(err));
    } else if (c) {
      res.end("✅ Authorized — close this tab and return to the terminal.");
      server.close();
      resolve(c);
    } else {
      res.statusCode = 204;
      res.end();
    }
  });
  server.on("error", reject);
  server.listen(PORT);
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});
const tok = await res.json();
if (!res.ok || !tok.refresh_token) {
  console.error(`✖ token exchange failed (${res.status}): ${JSON.stringify(tok)}`);
  if (res.ok && !tok.refresh_token)
    console.error(
      "  (No refresh_token returned — Google only sends one on first consent.\n" +
        "   Remove this app's access at https://myaccount.google.com/permissions and re-run.)"
    );
  process.exit(1);
}

const line = `GSC_OAUTH_REFRESH_TOKEN=${tok.refresh_token}`;
let appended = false;
if (existsSync(".env.local") && !readFileSync(".env.local", "utf8").includes("GSC_OAUTH_REFRESH_TOKEN")) {
  appendFileSync(".env.local", `\n# Google Search Console OAuth refresh token (minted by gsc-auth.mjs)\n${line}\n`);
  appended = true;
}

console.log("\n✅ Got a refresh token.");
if (appended) console.log("   Appended to .env.local — you're ready: `npm run audit:gsc`");
else
  console.log(
    "   Add this line to .env.local (a GSC_OAUTH_REFRESH_TOKEN already exists or\n" +
      "   .env.local is missing — not overwriting):\n\n   " +
      line +
      "\n"
  );
