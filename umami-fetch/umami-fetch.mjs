// ─────────────────────────────────────────────────────────────────────────────
// UMAMI on-site analytics fetch
//
// The "after the click" half of the funnel — complements ../gsc-fetch (search
// demand, "before the click"). Pulls a self-hosted Umami v3 instance and reports
// what real visitors DO on-site: traffic, where they actually come from
// (referrers — the distribution-channel reality check), top pages,
// countries/devices, custom events, UTM campaigns, plus configured funnels.
//
// Dependency-free: logs in with username/password (node:fetch), no SDK.
//
//   node umami-fetch/umami-fetch.mjs                # last 30 days
//   UMAMI_DAYS=7 node umami-fetch/umami-fetch.mjs
//
// Env (gitignored .env.local):
//   UMAMI_API_URL      e.g. https://analytics.example.com   (with or without /api)
//   UMAMI_WEBSITE_ID   the tracked site's website id (Umami → Settings → Websites)
//   UMAMI_USERNAME / UMAMI_PASSWORD   (self-hosted login; v3 cloud keys not supported)
//   UMAMI_DAYS         lookback window (default 30)
//   UMAMI_DC_COUNTRIES comma list of datacenter/bot countries to subtract from
//                      the totals as an "adjusted" row (optional, e.g. "SG,HK")
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const BASE = (process.env.UMAMI_API_URL || "").replace(/\/$/, "").replace(/\/api$/, "");
const WID = process.env.UMAMI_WEBSITE_ID;
const USER = process.env.UMAMI_USERNAME;
const PASS = process.env.UMAMI_PASSWORD;
const DAYS = Number(process.env.UMAMI_DAYS || 30);
// Countries whose traffic is overwhelmingly datacenter/crawler, not readers.
// Umami's filter params are equality-only (no "not equals"), so we fetch each
// suspect country's stats separately and SUBTRACT them from the totals.
const DC_COUNTRIES = (process.env.UMAMI_DC_COUNTRIES || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!BASE || !WID || !USER || !PASS) {
  console.error("✖ Set UMAMI_API_URL, UMAMI_WEBSITE_ID, UMAMI_USERNAME, UMAMI_PASSWORD (in .env.local or the environment).");
  process.exit(1);
}

const end = Date.now();
const start = end - DAYS * 86400000;

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) throw new Error(`umami login ${r.status}: ${await r.text()}`);
  return (await r.json()).token;
}

const H = (token) => ({ Authorization: `Bearer ${token}` });

async function get(token, path) {
  const r = await fetch(`${BASE}${path}`, { headers: H(token) });
  if (!r.ok) return null; // tolerate per-metric quirks (some types 400 on certain versions)
  return r.json();
}

const metric = (token, type, limit = 12) =>
  get(token, `/api/websites/${WID}/metrics?type=${type}&startAt=${start}&endAt=${end}&limit=${limit}`);

console.log(`▶ Umami ${WID}  last ${DAYS}d …`);
const token = await login();

const stats = await get(token, `/api/websites/${WID}/stats?startAt=${start}&endAt=${end}`);
const [referrers, urls, countries, devices, browsers, os, events, queries] = await Promise.all([
  metric(token, "referrer"),
  metric(token, "path"), // Umami v3 renamed type=url → type=path
  metric(token, "country"),
  metric(token, "device"),
  metric(token, "browser"),
  metric(token, "os"),
  metric(token, "event"),
  metric(token, "query"),
]);
const reports = await get(token, `/api/reports?websiteId=${WID}&page=1&pageSize=50`);

// per-datacenter-country stats, to subtract from the totals
const dcStats = await Promise.all(
  DC_COUNTRIES.map((c) =>
    get(token, `/api/websites/${WID}/stats?startAt=${start}&endAt=${end}&country=${encodeURIComponent(c)}`)
  )
);

// ── derived ───────────────────────────────────────────────────────────────────
const pv = stats?.pageviews ?? 0;
const visitors = stats?.visitors ?? 0;
const visits = stats?.visits ?? 0;
const bounces = stats?.bounces ?? 0;
const bounceRate = visits ? Math.round((bounces / visits) * 100) : 0;
const avgSec = visits ? Math.round((stats?.totaltime ?? 0) / visits) : 0;

// adjusted totals = totals minus the datacenter countries
const dcSum = (key) => dcStats.reduce((n, s) => n + (s?.[key] ?? 0), 0);
const adj = {
  pv: pv - dcSum("pageviews"),
  visitors: visitors - dcSum("visitors"),
  visits: visits - dcSum("visits"),
  bounces: bounces - dcSum("bounces"),
  totaltime: (stats?.totaltime ?? 0) - dcSum("totaltime"),
};
const adjBounceRate = adj.visits ? Math.round((adj.bounces / adj.visits) * 100) : 0;
const adjAvgSec = adj.visits ? Math.round(adj.totaltime / adj.visits) : 0;

const rows = (arr, label = "x", val = "y") =>
  (arr || []).map((r) => `| ${r[label]} | ${r[val]} |`).join("\n");

// referrer channel rollup (search vs social vs direct vs other)
const channel = (host) => {
  if (!host) return "direct";
  if (/google|bing|duckduckgo|ecosia|yahoo|yandex|baidu|search/i.test(host)) return "search";
  if (/reddit|news\.ycombinator|t\.co|twitter|x\.com|facebook|linkedin|youtube|hashnode|dev\.to|mastodon|lemmy/i.test(host)) return "social";
  // hosts counted as "internal" (your own domains / auth callbacks)
  const INTERNAL = (process.env.UMAMI_INTERNAL_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (INTERNAL.some((h) => host.includes(h))) return "internal";
  return "other";
};
const chTotals = {};
for (const r of referrers || []) chTotals[channel(r.x)] = (chTotals[channel(r.x)] || 0) + r.y;

// UTM rollup: this Umami version 400s on type=utm_*, so parse the `query` metric
// (each row = a full query string + hit count) into source/medium/campaign tables.
function parseUtm(queries) {
  const byCampaign = {}, bySourceMedium = {}, detailed = {};
  let total = 0;
  for (const r of queries || []) {
    const qs = new URLSearchParams(r.x || "");
    const s = qs.get("utm_source"), m = qs.get("utm_medium"), c = qs.get("utm_campaign");
    if (!s && !m && !c) continue; // ignore non-UTM query strings
    const y = r.y || 0; total += y;
    const src = s || "(none)", med = m || "(none)", camp = c || "(none)";
    byCampaign[camp] = (byCampaign[camp] || 0) + y;
    bySourceMedium[`${src} / ${med}`] = (bySourceMedium[`${src} / ${med}`] || 0) + y;
    detailed[`${src} / ${med} / ${camp}`] = (detailed[`${src} / ${med} / ${camp}`] || 0) + y;
  }
  const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return { total, byCampaign: sort(byCampaign), bySourceMedium: sort(bySourceMedium), detailed: sort(detailed) };
}
const utm = parseUtm(queries);

// ── report ──────────────────────────────────────────────────────────────────
const d = new Date();
const stamp = `${d.toISOString().slice(0, 10)}_${d.toTimeString().slice(0, 8).replace(/:/g, "-")}`;
mkdirSync("reports", { recursive: true });

let md = `# Umami — website ${WID.slice(0, 8)}… (on-site analytics)\n\n`;
md += `> Last **${DAYS} days**. The post-click half of the funnel (pair with the GSC report for the full picture).\n\n`;
md += `## Totals\n\n| | Pageviews | Visitors | Visits | Bounce | Avg time |\n|---|---|---|---|---|---|\n`;
md += `| raw | ${pv} | ${visitors} | ${visits} | ${bounceRate}% | ${avgSec}s |\n`;
if (DC_COUNTRIES.length) {
  md += `| **adjusted** (excl. ${DC_COUNTRIES.join(", ")}) | **${adj.pv}** | **${adj.visitors}** | **${adj.visits}** | **${adjBounceRate}%** | **${adjAvgSec}s** |\n\n`;
  md += `_"Adjusted" subtracts the datacenter/crawler countries (${DC_COUNTRIES.join(", ")}) — use it for trend decisions; raw is kept for comparability. Configure via \`UMAMI_DC_COUNTRIES\`._\n\n`;
} else md += `\n`;

md += `## 📣 Traffic channels (the distribution reality check)\n\n`;
md += `_Where visits actually come from. A healthy growth engine has more than just "search"._\n\n`;
md += `| Channel | Visits |\n|---|---|\n`;
md += Object.entries(chTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n") || "| — | — |";
md += `\n\n### Referrers (raw)\n\n| Source | Visits |\n|---|---|\n${rows(referrers) || "| — | — |"}\n\n`;

md += `## Top pages\n\n| Path | Views |\n|---|---|\n${rows(urls) || "| (url metric unavailable on this Umami version — see UI) | — |"}\n\n`;
const countryRows = (countries || [])
  .map((r) => `| ${r.x}${DC_COUNTRIES.includes(r.x) ? " ⚠️ datacenter (excluded from adjusted)" : ""} | ${r.y} |`)
  .join("\n");
md += `## Countries\n\n| Country | Visits |\n|---|---|\n${countryRows || "| — | — |"}\n\n`;
md += `## Devices\n\n| Device | Visits |\n|---|---|\n${rows(devices) || "| — | — |"}\n\n`;

md += `## Events (custom tracking)\n\n`;
if (events && events.length) md += `| Event | Count |\n|---|---|\n${rows(events)}\n\n`;
else md += `_None — no \`data-umami-event\` tracking on the site yet. This is the biggest gap: without events, funnels/goals can only use page URLs. Wire CTAs/outbound/claps/search._\n\n`;

md += `## UTM / campaigns\n\n`;
if (utm.total) {
  const utmRows = (arr) => arr.map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  md += `_${utm.total} UTM-tagged visit(s) in the window (parsed from the \`query\` metric — this Umami version 400s on \`type=utm_*\`). Note: datacenter/email-scanner clicks can show up here with mangled UTM values — treat odd source/campaign names as bot noise, not readers._\n\n`;
  md += `### By campaign\n\n| Campaign | Visits |\n|---|---|\n${utmRows(utm.byCampaign)}\n\n`;
  md += `### By source / medium\n\n| Source / Medium | Visits |\n|---|---|\n${utmRows(utm.bySourceMedium)}\n\n`;
  md += `### Detailed (source / medium / campaign)\n\n| Source / Medium / Campaign | Visits |\n|---|---|\n${utmRows(utm.detailed)}\n\n`;
} else {
  md += `_No UTM-tagged traffic captured. When posting to Reddit/HN/newsletter, append \`?utm_source=…&utm_medium=…&utm_campaign=…\` so channels attribute here._\n\n`;
}

md += `## Funnels / goals (reports)\n\n`;
const reps = reports?.data || [];
if (reps.length) md += reps.map((r) => `- **${r.name}** (${r.type})`).join("\n") + "\n";
else md += `_No funnels/goals configured yet._\n`;

const mdPath = `reports/umami-${stamp}.md`;
writeFileSync(mdPath, md);
writeFileSync(
  `reports/umami-${stamp}.json`,
  JSON.stringify({ stats, adjusted: { ...adj, dcCountries: DC_COUNTRIES }, channels: chTotals, referrers, urls, countries, devices, browsers, os, events, queries, utm, reports: reps }, null, 2)
);

console.log(`\n✅ done:\n   MD:   ${mdPath}`);
console.log(`Totals: ${pv} pv / ${visitors} visitors / bounce ${bounceRate}%`);
console.log(`Adjusted (excl. ${DC_COUNTRIES.join(",")}): ${adj.pv} pv / ${adj.visitors} visitors / bounce ${adjBounceRate}%`);
console.log(`Channels: ${Object.entries(chTotals).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
console.log(`Events tracked: ${events?.length || 0}  ·  Funnels/goals: ${reps.length}`);
console.log(`UTM visits: ${utm.total}${utm.byCampaign.length ? "  (top campaign: " + utm.byCampaign[0][0] + "=" + utm.byCampaign[0][1] + ")" : ""}`);
