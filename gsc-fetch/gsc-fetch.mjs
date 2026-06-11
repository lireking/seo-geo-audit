// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SEARCH CONSOLE fetch + opportunity analysis
//
// The demand-side complement to ../seo-audit (structure) and ../perf-audit
// (speed): those tell you the site is *technically* healthy; THIS tells you what
// real users actually search for and where the fastest traffic wins are.
//
// Pulls the Search Analytics API (last N days) for a property and, beyond the raw
// top-queries/top-pages dumps, computes the two reports a solo operator actually
// acts on:
//   • STRIKING DISTANCE  — queries ranking position 5–20 with real impressions:
//     a small title/content tweak can pull them onto page 1. Highest ROI per hour.
//   • LOW-CTR WINNERS     — queries already ranking top-5 but with below-curve CTR:
//     fix the title/meta to earn the clicks you're already impressing for.
//
// Dependency-free: signs a service-account JWT with node:crypto and calls the
// REST API directly — no googleapis npm dep, so package.json / lockfile / the
// Docker image are untouched (this is a LOCAL dev tool, like the other audits).
//
//   node gsc-fetch/gsc-fetch.mjs "sc-domain:example.com"
//   GSC_DAYS=28 node gsc-fetch/gsc-fetch.mjs       # shorter window
//
// Env (put in gitignored .env.local):
//   GSC_SA_KEY    path to the service-account JSON key file (keep OUTSIDE the repo)
//   GSC_SITE_URL  property exactly as in GSC (or pass as the positional arg):
//                   domain property     → "sc-domain:example.com"
//                   URL-prefix property → "https://www.example.com/"
//   GSC_DAYS      lookback window in days (default 90)
//   GSC_SD_MIN_IMPR  min impressions to count as striking-distance (default 20)
//
// SETUP (one-time, Google side — see scripts/gsc-fetch/README on first run):
//   1. Google Cloud console → enable "Google Search Console API" on a project
//   2. Create a Service Account → add a JSON key → download it
//   3. In Search Console → Settings → Users & permissions → add the service
//      account's client_email as a user (Restricted is enough — read-only)
//   4. Point GSC_SA_KEY at the downloaded JSON, set GSC_SITE_URL
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";

// ── load .env.local (dependency-free, same pattern as perf-audit) ────────────
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

// Two auth modes. OAuth (runs as YOU, the property owner — no GSC user-add) is
// preferred when adding a service account to GSC is blocked by org policy. The
// service-account path stays supported for headless/CI use where it's allowed.
const SA_KEY_PATH = process.env.GSC_SA_KEY;
const OAUTH = {
  clientId: process.env.GSC_OAUTH_CLIENT_ID,
  clientSecret: process.env.GSC_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.GSC_OAUTH_REFRESH_TOKEN,
};
const USE_OAUTH = OAUTH.clientId && OAUTH.clientSecret && OAUTH.refreshToken;
const SITE_URL = process.env.GSC_SITE_URL || process.argv[2];
const DAYS = Number(process.env.GSC_DAYS || 90);
const SD_MIN_IMPR = Number(process.env.GSC_SD_MIN_IMPR || 20);

if (!SITE_URL) {
  console.error('✖ No property. Pass it as an arg (node gsc-fetch.mjs "sc-domain:example.com") or set GSC_SITE_URL.');
  process.exit(1);
}
if (!USE_OAUTH && !SA_KEY_PATH) {
  console.error(
    "✖ No credentials. Set EITHER:\n" +
      "  • OAuth — GSC_OAUTH_CLIENT_ID/SECRET, then run\n" +
      "      node gsc-fetch/gsc-auth.mjs   (mints GSC_OAUTH_REFRESH_TOKEN)\n" +
      "  • or a service-account key — GSC_SA_KEY=/path/to/key.json\n" +
      "  See the README."
  );
  process.exit(1);
}

// ── service-account JWT → OAuth2 access token (no googleapis dep) ─────────────
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getAccessToken() {
  // OAuth mode: trade the long-lived refresh token for a short access token.
  if (USE_OAUTH) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH.clientId,
        client_secret: OAUTH.clientSecret,
        refresh_token: OAUTH.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`oauth refresh ${res.status}: ${JSON.stringify(json)}`);
    return json.access_token;
  }
  // Service-account mode: sign a JWT and exchange it.
  let sa;
  try {
    sa = JSON.parse(readFileSync(SA_KEY_PATH, "utf8"));
  } catch (e) {
    throw new Error(`cannot read service-account key at ${SA_KEY_PATH}: ${e.message}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ── Search Analytics query ───────────────────────────────────────────────────
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function query(token, body) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    SITE_URL
  )}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`searchAnalytics ${res.status}: ${JSON.stringify(json)}`);
  return json.rows || [];
}

// ── expected CTR by position (rough industry curve, for low-CTR detection) ────
const EXPECTED_CTR = { 1: 0.28, 2: 0.15, 3: 0.1, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.018 };
const expectedCtr = (pos) => EXPECTED_CTR[Math.round(pos)] ?? (pos <= 20 ? 0.01 : 0.005);

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const pos = (n) => n.toFixed(1);

// ── main ─────────────────────────────────────────────────────────────────────
const end = new Date();
const start = new Date(end);
start.setDate(start.getDate() - DAYS);
// GSC data lags ~2-3 days; clamp the end back so we don't query empty fresh days.
end.setDate(end.getDate() - 2);
const startDate = ymd(start);
const endDate = ymd(end);

console.log(`▶ GSC ${SITE_URL}  ${startDate} → ${endDate} (${DAYS}d)  [auth: ${USE_OAUTH ? "oauth" : "service-account"}]…`);

const token = await getAccessToken();

const [queries, pages, trend] = await Promise.all([
  query(token, { startDate, endDate, dimensions: ["query"], rowLimit: 1000 }),
  query(token, { startDate, endDate, dimensions: ["page"], rowLimit: 1000 }),
  query(token, { startDate, endDate, dimensions: ["date"], rowLimit: 500 }),
]);

const totals = queries.reduce(
  (a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }),
  { clicks: 0, impressions: 0 }
);
const siteCtr = totals.impressions ? totals.clicks / totals.impressions : 0;

const topByClicks = [...queries].sort((a, b) => b.clicks - a.clicks).slice(0, 30);
const topByImpr = [...queries].sort((a, b) => b.impressions - a.impressions).slice(0, 30);

// STRIKING DISTANCE: ranking just off page 1 (pos 5–20) with real demand.
const striking = queries
  .filter((r) => r.position >= 5 && r.position <= 20 && r.impressions >= SD_MIN_IMPR)
  .map((r) => ({ ...r, opportunity: r.impressions * (21 - r.position) })) // closer to p1 = weightier
  .sort((a, b) => b.opportunity - a.opportunity)
  .slice(0, 25);

// LOW-CTR WINNERS: already top-5 but earning fewer clicks than the position implies.
const lowCtr = queries
  .filter((r) => r.position <= 5 && r.impressions >= SD_MIN_IMPR && r.ctr < expectedCtr(r.position) * 0.6)
  .map((r) => ({ ...r, lost: Math.round(r.impressions * (expectedCtr(r.position) - r.ctr)) }))
  .sort((a, b) => b.lost - a.lost)
  .slice(0, 20);

const topPages = [...pages].sort((a, b) => b.clicks - a.clicks).slice(0, 25);

// ── report ───────────────────────────────────────────────────────────────────
const stamp = `${ymd(new Date())}_${new Date().toTimeString().slice(0, 8).replace(/:/g, "-")}`;
mkdirSync("reports", { recursive: true });

const row = (cells) => `| ${cells.join(" | ")} |`;
const qpath = (u) => u.replace(/^https?:\/\/[^/]+/, "") || "/";

let md = `# Google Search Console — ${SITE_URL}\n\n`;
md += `> Window: **${startDate} → ${endDate}** (${DAYS} days; GSC lags ~2d so end is clamped back).\n\n`;
md += `## Totals\n\n`;
md += `| Clicks | Impressions | Avg CTR | Queries | Pages |\n|---|---|---|---|---|\n`;
md += row([totals.clicks, totals.impressions, pct(siteCtr), queries.length, pages.length]) + "\n\n";

md += `## 🎯 Striking distance — pos 5–20, ≥${SD_MIN_IMPR} impr (fastest traffic wins)\n\n`;
md += `_Pull these onto page 1 with a title/H1/content tweak. Sorted by opportunity (impressions × closeness to p1)._\n\n`;
if (striking.length) {
  md += `| Query | Pos | Impr | Clicks | CTR |\n|---|---|---|---|---|\n`;
  for (const r of striking) md += row([r.keys[0], pos(r.position), r.impressions, r.clicks, pct(r.ctr)]) + "\n";
} else md += `_None yet — too little impression data; revisit once traffic grows._\n`;
md += `\n`;

md += `## 📉 Low-CTR winners — top-5 rank, under-earning clicks\n\n`;
md += `_Already ranking well; a sharper title/meta description earns the clicks you're already impressing for. "Lost" ≈ clicks left on the table vs the expected CTR curve._\n\n`;
if (lowCtr.length) {
  md += `| Query | Pos | Impr | CTR | ~Lost clicks |\n|---|---|---|---|---|\n`;
  for (const r of lowCtr) md += row([r.keys[0], pos(r.position), r.impressions, pct(r.ctr), r.lost]) + "\n";
} else md += `_None flagged._\n`;
md += `\n`;

md += `## Top queries by clicks\n\n| Query | Clicks | Impr | CTR | Pos |\n|---|---|---|---|---|\n`;
for (const r of topByClicks) md += row([r.keys[0], r.clicks, r.impressions, pct(r.ctr), pos(r.position)]) + "\n";
md += `\n## Top queries by impressions\n\n| Query | Impr | Clicks | CTR | Pos |\n|---|---|---|---|---|\n`;
for (const r of topByImpr) md += row([r.keys[0], r.impressions, r.clicks, pct(r.ctr), pos(r.position)]) + "\n";
md += `\n## Top pages by clicks\n\n| Page | Clicks | Impr | CTR | Pos |\n|---|---|---|---|---|\n`;
for (const r of topPages) md += row([qpath(r.keys[0]), r.clicks, r.impressions, pct(r.ctr), pos(r.position)]) + "\n";

const mdPath = `reports/gsc-${stamp}.md`;
const jsonPath = `reports/gsc-${stamp}.json`;
writeFileSync(mdPath, md);
writeFileSync(
  jsonPath,
  JSON.stringify({ site: SITE_URL, startDate, endDate, totals, striking, lowCtr, queries, pages, trend }, null, 2)
);

console.log(`\n✅ done:\n   MD:   ${mdPath}\n   JSON: ${jsonPath}\n`);
console.log(`Totals: ${totals.clicks} clicks / ${totals.impressions} impr / CTR ${pct(siteCtr)}`);
console.log(`Striking-distance opportunities: ${striking.length}  ·  Low-CTR winners: ${lowCtr.length}`);
