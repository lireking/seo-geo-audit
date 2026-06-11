// ─────────────────────────────────────────────────────────────────────────────
// Render an audit JSON (from crawl.mjs) into a detailed SEO + GEO markdown report.
//
//   node report.mjs audit.json            # markdown to stdout
//   node report.mjs audit.json out.md     # …and write to file
//
// GEO = Generative Engine Optimization: signals that help AI answer-engines
// (ChatGPT, Claude, Perplexity, Google AI Overviews) ingest & cite the page —
// structured data, clean heading outlines, content depth, AI-crawler access.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node report.mjs <audit.json> [out.md]"); process.exit(1); }
const D = JSON.parse(readFileSync(file, "utf8"));
const HOST = D.meta.host;
const ORIGIN = `https://${HOST}`;
const norm = (u) => (u || "").replace(/\/+$/, "") || "/";
const pageUrl = (p) => norm(ORIGIN + (p === "/" ? "" : p));

const pages = D.pages;
const ok = pages.filter((p) => p.status === 200);
const html = ok.filter((p) => /text\/html/i.test(p.ctype || "") || p.title !== undefined);
const indexable = html.filter((p) => !p.noindex);

// ── collectors ───────────────────────────────────────────────────────────────
const I = {}; // issue key -> array of detail strings
const add = (k, detail) => (I[k] ||= []).push(detail);

// sitemap-level
for (const d of D.sitemap.duplicates) add("Page in multiple sitemaps (duplicate <loc>)", `${d.path} ×${d.count}`);
for (const p of pages) {
  if (p.status === 404) add("404 in sitemap", p.path);
  else if (p.status >= 400) add(`${p.status} in sitemap`, p.path);
  else if (p.status >= 300 && p.status < 400) add("Redirect in sitemap (non-canonical URL listed)", `${p.path} → ${p.location}`);
}

// per-page SEO
const titleMap = {}, descMap = {};
for (const p of html) {
  if (p.status !== 200) continue;
  if (p.metaStreamedToBody) add("Metadata streamed to body (present, but JS-less crawlers miss it)", p.path);
  if (p.noindex) add("Noindex page (in sitemap)", `${p.path}  [robots: ${p.robots}]`);
  if (p.nofollow) add("Nofollow page", `${p.path}  [robots: ${p.robots}]`);
  if (!p.title) add("Title missing/empty", p.path);
  else {
    (titleMap[p.title] ||= []).push(p.path);
    if (p.titleLen > 60) add("Title too long (>60)", `${p.path} — ${p.titleLen}c — “${p.title.slice(0, 70)}”`);
    else if (p.titleLen < 15) add("Title too short (<15)", `${p.path} — ${p.titleLen}c — “${p.title}”`);
  }
  if (!p.desc) add("Meta description missing", p.path);
  else {
    (descMap[p.desc] ||= []).push(p.path);
    if (p.descLen > 160) add("Meta description too long (>160)", `${p.path} — ${p.descLen}c`);
    else if (p.descLen < 50) add("Meta description too short (<50)", `${p.path} — ${p.descLen}c`);
  }
  if (p.h1 === 0) add("H1 missing", p.path);
  else if (p.h1 > 1) add("Multiple H1", `${p.path} — ${p.h1}×`);
  if (!p.canonical) add("Canonical missing", p.path);
  else {
    const cp = canonPath(p.canonical);
    const cs = cp != null ? D.statuses[cp] : undefined;
    if (cs !== undefined && (cs >= 400 || cs === 0)) add("Canonical points to 4XX/broken", `${p.path} → ${p.canonical} [${cs}]`);
    else if (cs !== undefined && cs >= 300 && cs < 400) add("Canonical points to redirect", `${p.path} → ${p.canonical} [${cs}]`);
  }
  if (!p.og?.title || !p.og?.image) add("Open Graph incomplete (title/image)", p.path);
  if (!p.twitter) add("Twitter card missing", p.path);
  if (!p.htmlLang) add("html[lang] missing", p.path);
  // hreflang
  if (!(p.hreflangs || []).length) add("hreflang annotations missing", p.path);
  else {
    const self = p.hreflangs.some((h) => norm(h.href) === pageUrl(p.path));
    if (!self) add("hreflang self-reference missing/wrong", `${p.path} → [${p.hreflangs.map((h) => `${h.lang}:${h.href}`).join(", ")}]`);
  }
}
// duplicate title/desc across indexable pages
for (const [t, ps] of Object.entries(titleMap)) if (ps.filter((x) => !byPath(x)?.noindex).length > 1) add("Duplicate title (indexable)", `“${t.slice(0, 60)}” → ${ps.join(", ")}`);
for (const [, ps] of Object.entries(descMap)) if (ps.filter((x) => !byPath(x)?.noindex).length > 1) add("Duplicate meta description (indexable)", ps.join(", "));

// ── GEO checks ───────────────────────────────────────────────────────────────
const G = {};
const gadd = (k, d) => (G[k] ||= []).push(d);
for (const p of indexable) {
  if (p.status !== 200) continue;
  if (!(p.jsonLd || []).length) {
    if (p.jsonLdClientOnly) gadd("JSON-LD injected client-side only (JS-less AI crawlers miss it)", p.path);
    else gadd("No JSON-LD structured data at all", p.path);
  }
  if (p.jsonLdInvalid) gadd("Invalid JSON-LD (parse error)", p.path);
  if (p.words < 300) gadd("Thin content (<300 words)", `${p.path} — ${p.words}w`);
  // heading outline sanity: should start at h1, no skipped levels
  const levels = (p.headings || []).map((h) => h.level);
  if (levels.length && levels[0] !== 1) gadd("Heading outline does not start at H1", `${p.path} — starts h${levels[0]}`);
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) { gadd("Heading level skipped (outline gap)", `${p.path} — h${levels[i - 1]}→h${levels[i]}`); break; }
  if (p.imgsNoAlt > 0) gadd("Images without alt text", `${p.path} — ${p.imgsNoAlt}`);
}
// structured-data type coverage across the site (informational)
const ldTypes = {};
for (const p of indexable) for (const t of p.jsonLd || []) ldTypes[t] = (ldTypes[t] || 0) + 1;

// AI crawler access from robots.txt
const robots = D.geo.robotsTxt || "";
const aiBots = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "anthropic-ai", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"];
const robotsFindings = [];
if (D.geo.robotsStatus !== 200) robotsFindings.push(`robots.txt returned ${D.geo.robotsStatus}`);
if (robots && !/sitemap:/i.test(robots)) robotsFindings.push("robots.txt has no Sitemap: directive");
const blocked = aiBots.filter((b) => new RegExp(`User-agent:\\s*${b}[\\s\\S]*?Disallow:\\s*/\\s*$`, "im").test(robots));
const llms = ["/llms.txt", "/llms-full.txt", "/.well-known/llms.txt"].filter((f) => D.geo[f] === 200);

// link health
const linkAudit = D.linkAudit || [];
const brokenTargetTally = {};
for (const la of linkAudit) for (const b of la.broken) { const key = `${b.target} [${b.status}${b.final ? `→${b.final}` : ""}]`; brokenTargetTally[key] = (brokenTargetTally[key] || 0) + 1; }
const pagesWithBroken = linkAudit.filter((l) => l.broken.length).length;
const pagesWithRedir = linkAudit.filter((l) => l.redirects.length).length;

// ── helpers ──────────────────────────────────────────────────────────────────
function byPath(p) { return pages.find((x) => x.path === p); }
function canonPath(u) { try { const url = new URL(u); return url.host === HOST ? (url.pathname + url.search) : null; } catch { return u.startsWith("/") ? u : null; } }

// ── render ───────────────────────────────────────────────────────────────────
const L = [];
const w = (s = "") => L.push(s);
const sev = (n) => (n === 0 ? "✅" : n <= 3 ? "🟡" : "🔴");
const list = (arr, max = 40) => arr.slice(0, max).map((x) => `  - ${x}`).join("\n") + (arr.length > max ? `\n  - …+${arr.length - max} more` : "");

w(`# SEO + GEO Audit — ${HOST}`);
w("");
w(`> Crawled the sitemap + every internal link/image target (static HTML view — what JS-less crawlers see).`);
w("");
w(`## Overview`);
w("");
w(`| Metric | Value |`);
w(`|---|---|`);
w(`| Sitemap URLs | ${D.sitemap.total} (${D.sitemap.unique} unique${D.sitemap.duplicates.length ? `, ⚠️ ${D.sitemap.duplicates.length} duplicated` : ""}) |`);
w(`| Pages 200 | ${pages.filter((p) => p.status === 200).length} |`);
w(`| Pages 4xx in sitemap | ${pages.filter((p) => p.status >= 400).length} |`);
w(`| Pages 3xx in sitemap | ${pages.filter((p) => p.status >= 300 && p.status < 400).length} |`);
w(`| Indexable HTML pages | ${indexable.length} |`);
w(`| Noindex HTML pages | ${html.filter((p) => p.noindex).length} |`);
w(`| Pages with broken outgoing links | ${pagesWithBroken} |`);
w(`| Pages with redirecting outgoing links | ${pagesWithRedir} |`);
w(`| Distinct broken link targets | ${Object.keys(brokenTargetTally).length} |`);
w("");

// SEO issue summary
const seoKeys = Object.keys(I).sort((a, b) => I[b].length - I[a].length);
w(`## SEO issues (${seoKeys.reduce((n, k) => n + I[k].length, 0)} findings across ${seoKeys.length} types)`);
w("");
w(`| | Issue | Count |`);
w(`|---|---|---|`);
for (const k of seoKeys) w(`| ${sev(I[k].length)} | ${k} | ${I[k].length} |`);
w("");

// GEO issue summary
const geoKeys = Object.keys(G).sort((a, b) => G[b].length - G[a].length);
w(`## GEO / AI-readiness issues`);
w("");
w(`| | Signal | Count |`);
w(`|---|---|---|`);
for (const k of geoKeys) w(`| ${sev(G[k].length)} | ${k} | ${G[k].length} |`);
w(`| ${llms.length ? "✅" : "🟡"} | llms.txt present | ${llms.length ? llms.join(", ") : "none"} |`);
w(`| ${blocked.length ? "🔴" : "✅"} | AI crawlers blocked in robots.txt | ${blocked.length ? blocked.join(", ") : "none blocked"} |`);
for (const r of robotsFindings) w(`| 🟡 | ${r} | — |`);
w("");
w(`**JSON-LD @types found site-wide:** ${Object.entries(ldTypes).map(([t, n]) => `${t} (${n})`).join(", ") || "none"}`);
w("");

// Top broken targets
if (Object.keys(brokenTargetTally).length) {
  w(`## Broken link targets (by inbound link count)`);
  w("");
  w(`| Target | Status | Pages linking |`);
  w(`|---|---|---|`);
  for (const [t, n] of Object.entries(brokenTargetTally).sort((a, b) => b[1] - a[1]).slice(0, 50)) {
    const mm = t.match(/^(.*) \[(.*)\]$/); w(`| ${mm ? mm[1] : t} | ${mm ? mm[2] : ""} | ${n} |`);
  }
  w("");
}

// Detailed appendices
w(`---`);
w(`## Detail — SEO findings`);
w("");
for (const k of seoKeys) { w(`### ${sev(I[k].length)} ${k} (${I[k].length})`); w(list(I[k])); w(""); }

w(`## Detail — GEO findings`);
w("");
for (const k of geoKeys) { w(`### ${sev(G[k].length)} ${k} (${G[k].length})`); w(list(G[k])); w(""); }

if (linkAudit.length) {
  w(`## Detail — pages with broken/redirecting outgoing links`);
  w("");
  for (const la of linkAudit.filter((l) => l.broken.length || l.brokenImgs.length).slice(0, 60)) {
    w(`**${la.path}**`);
    for (const b of la.broken) w(`  - ✖ ${b.target} [${b.status}${b.final ? `→${b.final}` : ""}]`);
    for (const im of la.brokenImgs) w(`  - 🖼 ${im.src} [${im.status}]`);
    w("");
  }
}

const md = L.join("\n");
process.stdout.write(md);
if (process.argv[3]) writeFileSync(process.argv[3], md);
