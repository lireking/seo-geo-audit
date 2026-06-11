// ─────────────────────────────────────────────────────────────────────────────
// PERF + CWV + JS-RENDER + BACKLINKS audit  (the heavy, browser-based half —
// complements the fast static-HTML auditor in ../seo-audit).
//
// Runs locally with Playwright chromium against the LIVE site (the one tool in
// this kit with a dependency: `npm i playwright`). Optionally pin the hostname
// to a specific IP via PERF_IP (--host-resolver-rules) to bypass flaky DNS or
// to measure a specific origin server. For each sampled page it captures:
//   • Core Web Vitals (lab): LCP, CLS, FCP, TTFB, TBT (INP needs field data)
//   • Performance budget: transfer bytes by type, request count, DCL/load
//   • JS rendering: post-hydration DOM facts (title/JSON-LD/canonical the way a
//     JS-executing crawler like Google sees them) + console/page errors
//   • Backlinks: pluggable provider (Ahrefs/Moz/…) via env — honest no-op w/o key
//
//   node perf-audit/perf-audit.mjs https://example.com
//   node perf-audit/perf-audit.mjs https://example.com "/,/about,/blog"
//
// Env:
//   PERF_BASE   origin (or pass as the first positional arg)
//   PERF_IP     IP to pin the host to (optional; default: normal DNS)
//   PERF_PATHS  comma-separated paths to sample (or 2nd positional arg; default "/")
//   PERF_SETTLE ms to wait after load for LCP/CLS to settle (default 3500)
//   BACKLINKS_PROVIDER + AHREFS_API_TOKEN / MOZ_* …  (see getBacklinks)
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

// Playwright is the ONE dependency in this kit, used only by this tool.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  process.stderr.write("✖ perf-audit needs Playwright:\n    npm i playwright && npx playwright install chromium\n");
  process.exit(1);
}

// Load .env.local (dependency-free) so PSI_API_KEY (Google PageSpeed Insights)
// is available for the CrUX field-data / INP integration below.
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const BASE = (process.env.PERF_BASE || process.argv[2] || "").replace(/\/$/, "");
if (!BASE) {
  process.stderr.write('usage: node perf-audit.mjs <https://your-site.com> ["/,/about"]   (or set PERF_BASE)\n');
  process.exit(1);
}
const HOST = new URL(BASE).host;
const IP = process.env.PERF_IP ?? "";
const SETTLE = Number(process.env.PERF_SETTLE || 3500);
const PATHS = (process.env.PERF_PATHS || process.argv[3] || "/").split(",").map((p) => p.trim());

// CWV thresholds (Google "good" / "poor")
const CWV = {
  LCP: { good: 2500, poor: 4000, unit: "ms" },
  CLS: { good: 0.1, poor: 0.25, unit: "" },
  FCP: { good: 1800, poor: 3000, unit: "ms" },
  TTFB: { good: 800, poor: 1800, unit: "ms" },
  TBT: { good: 200, poor: 600, unit: "ms" },
};
const rate = (k, v) => (v == null ? "?" : v <= CWV[k].good ? "good" : v <= CWV[k].poor ? "needs-improvement" : "poor");

// Installed before any page script runs → captures LCP/CLS/longtasks from the start.
const VITALS_INIT = `
  window.__v = { lcp: 0, cls: 0, tbt: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__v.lcp = e.startTime || e.renderTime || window.__v.lcp; })
      .observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__v.cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__v.tbt += Math.max(0, e.duration - 50); })
      .observe({ type: "longtask", buffered: true });
  } catch (e) {}
`;

async function auditPage(browser, path) {
  const ctx = await browser.newContext({ bypassCSP: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.addInitScript(VITALS_INIT);
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  const url = BASE + path;
  const out = { path, url, ok: false };
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: 45000 });
    out.status = resp ? resp.status() : 0;
    await page.waitForTimeout(SETTLE); // let LCP/CLS settle

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const paint = performance.getEntriesByType("paint");
      const fcp = (paint.find((p) => p.name === "first-contentful-paint") || {}).startTime;
      const res = performance.getEntriesByType("resource");
      const byType = {};
      let totalBytes = (nav.transferSize || 0);
      for (const r of res) {
        const t = r.initiatorType || "other";
        const b = r.transferSize || 0;
        byType[t] = (byType[t] || 0) + b;
        totalBytes += b;
      }
      return {
        ttfb: Math.round(nav.responseStart || 0),
        fcp: fcp ? Math.round(fcp) : null,
        lcp: Math.round(window.__v.lcp || 0),
        cls: Math.round((window.__v.cls || 0) * 1000) / 1000,
        tbt: Math.round(window.__v.tbt || 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
        requests: res.length + 1,
        bytesTotal: totalBytes,
        bytesByType: byType,
        // JS-rendering view (what a JS-executing crawler sees AFTER hydration):
        render: {
          title: document.title || null,
          hasJsonLd: !!document.querySelector('script[type="application/ld+json"]'),
          jsonLdInHead: !!document.head.querySelector('script[type="application/ld+json"]'),
          canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
          metaDescription: (document.querySelector('meta[name="description"]') || {}).content || null,
          h1: document.querySelectorAll("h1").length,
          imgsNoAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
          hreflang: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
          // noindex pages (e.g. internal search results) legitimately have no
          // canonical/JSON-LD/hreflang — track it so the report doesn't false-flag them.
          noindex: /noindex/i.test((document.querySelector('meta[name="robots"]') || {}).content || ""),
        },
      };
    });
    Object.assign(out, metrics, { errors, ok: true });
  } catch (e) {
    out.error = e.message;
    out.errors = errors;
  } finally {
    await ctx.close();
  }
  return out;
}

// ── PageSpeed Insights: real CrUX FIELD data (incl. INP) + Lighthouse lab ─────
// PSI fetches the PUBLIC url from Google's servers, so it works regardless of the
// local host-pin. Field data (loadingExperience) exists only for URLs/origins
// with enough real Chrome traffic in CrUX; otherwise we fall back to origin-level
// or report "no field data". Key from .env.local (PSI_API_KEY).
const PSI_KEY = process.env.PSI_API_KEY;
async function psi(url) {
  if (!PSI_KEY) return null;
  const api =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
    `&key=${PSI_KEY}&strategy=mobile&category=performance`;
  try {
    const r = await fetch(api);
    if (!r.ok) return { error: `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const j = await r.json();
    const metrics = (le) => {
      if (!le?.metrics) return null;
      const g = (k, div = 1) =>
        le.metrics[k] ? { p75: le.metrics[k].percentile / div, cat: le.metrics[k].category } : null;
      return {
        LCP: g("LARGEST_CONTENTFUL_PAINT_MS"),
        INP: g("INTERACTION_TO_NEXT_PAINT"),
        CLS: g("CUMULATIVE_LAYOUT_SHIFT_SCORE", 100), // CrUX returns ×100
        FCP: g("FIRST_CONTENTFUL_PAINT_MS"),
        TTFB: g("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
      };
    };
    return {
      labScore: Math.round((j.lighthouseResult?.categories?.performance?.score ?? 0) * 100),
      urlField: metrics(j.loadingExperience),
      urlFieldOverall: j.loadingExperience?.overall_category || null,
      originField: metrics(j.originLoadingExperience),
      originFieldOverall: j.originLoadingExperience?.overall_category || null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── backlinks (pluggable; needs a paid provider — no free source exists) ──────
async function getBacklinks() {
  const provider = (process.env.BACKLINKS_PROVIDER || "").toLowerCase();
  const target = HOST;
  if (provider === "ahrefs" && process.env.AHREFS_API_TOKEN) {
    try {
      const u = `https://api.ahrefs.com/v3/site-explorer/backlinks-stats?target=${encodeURIComponent(
        target
      )}&mode=domain`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${process.env.AHREFS_API_TOKEN}` } });
      if (!r.ok) return { configured: true, provider, error: `HTTP ${r.status} ${await r.text().catch(() => "")}` };
      return { configured: true, provider, data: await r.json() };
    } catch (e) {
      return { configured: true, provider, error: e.message };
    }
  }
  return {
    configured: false,
    note:
      "Backlinks need a paid data provider — no free source exists. Set BACKLINKS_PROVIDER=ahrefs + " +
      "AHREFS_API_TOKEN (or wire Moz/Majestic in getBacklinks). Google Search Console's Links report is " +
      "the free-but-partial alternative (manual export).",
  };
}

// ── render markdown ──────────────────────────────────────────────────────────
function fmtBytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + " MB" : (n / 1e3).toFixed(0) + " KB"; }
function badge(k, v) { const r = rate(k, v); return r === "good" ? "🟢" : r === "needs-improvement" ? "🟡" : r === "poor" ? "🔴" : "⚪"; }

function renderMd(report) {
  const L = [];
  const w = (s = "") => L.push(s);
  w(`# Performance · CWV · JS-render — ${HOST}`);
  w("");
  w(`> Lab metrics via Playwright/chromium against ${BASE}${IP ? ` (host pinned → ${IP})` : ""}. ` +
    `Cold load per page, ${SETTLE}ms settle. INP/field data need real-user data (CrUX) — not measured here.`);
  w("");
  w(`## Core Web Vitals (lab)`);
  w("");
  w(`| Page | LCP | CLS | FCP | TTFB | TBT | Status |`);
  w(`|---|---|---|---|---|---|---|`);
  for (const p of report.pages) {
    if (!p.ok) { w(`| ${p.path} | — | — | — | — | — | ✖ ${p.error || p.status} |`); continue; }
    w(`| ${p.path} | ${badge("LCP", p.lcp)} ${p.lcp}ms | ${badge("CLS", p.cls)} ${p.cls} | ${badge("FCP", p.fcp)} ${p.fcp ?? "?"}ms | ${badge("TTFB", p.ttfb)} ${p.ttfb}ms | ${badge("TBT", p.tbt)} ${p.tbt}ms | ${p.status} |`);
  }
  w("");
  // Field CWV (CrUX p75, incl. INP) + Lighthouse lab — only if PSI ran
  if (report.pages.some((p) => p.psi)) {
    const fmtM = (m) => (m ? `${m.p75}${m.cat === "FAST" ? " 🟢" : m.cat === "AVERAGE" ? " 🟡" : " 🔴"}` : "—");
    w(`## Field data — CrUX p75 (real users, incl. INP) + Lighthouse lab`);
    w("");
    w(`> Source: PageSpeed Insights (mobile). URL-level field data exists only for high-traffic URLs; ` +
      `otherwise the origin-level row applies. "—" = no field data in CrUX.`);
    w("");
    w(`| Page | Lighthouse | LCP | INP | CLS | FCP | TTFB | scope |`);
    w(`|---|---|---|---|---|---|---|---|`);
    for (const p of report.pages) {
      if (!p.psi) continue;
      if (p.psi.error) { w(`| ${p.path} | ✖ ${p.psi.error} | | | | | | |`); continue; }
      const f = p.psi.urlField, o = p.psi.originField, m = f || o;
      const scope = f ? "url" : o ? "origin" : "none";
      w(`| ${p.path} | ${p.psi.labScore}/100 | ${fmtM(m?.LCP)} | ${fmtM(m?.INP)} | ${fmtM(m?.CLS)} | ${fmtM(m?.FCP)} | ${fmtM(m?.TTFB)} | ${scope} |`);
    }
    w("");
  }

  w(`## Performance budget`);
  w("");
  w(`| Page | Requests | Transfer | JS | CSS | Images | DOMContentLoaded | Load |`);
  w(`|---|---|---|---|---|---|---|---|`);
  for (const p of report.pages) {
    if (!p.ok) continue;
    const b = p.bytesByType || {};
    w(`| ${p.path} | ${p.requests} | ${fmtBytes(p.bytesTotal)} | ${fmtBytes(b.script || 0)} | ${fmtBytes((b.link || 0) + (b.css || 0))} | ${fmtBytes(b.img || 0)} | ${p.domContentLoaded}ms | ${p.load}ms |`);
  }
  w("");
  w(`## JS rendering (post-hydration DOM — what Google sees)`);
  w("");
  w(`| Page | robots | title | JSON-LD | canonical | meta-desc | H1 | img no-alt | hreflang | console errs |`);
  w(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const p of report.pages) {
    if (!p.ok) continue;
    const r = p.render || {};
    // On a noindex page, canonical/JSON-LD/hreflang are not expected → show "—", not ❌.
    const na = (present) => (r.noindex ? "—" : present ? "✅" : "❌");
    w(`| ${p.path} | ${r.noindex ? "noindex" : "index"} | ${r.title ? "✅" : "❌"} | ${na(r.hasJsonLd)} | ${na(r.canonical)} | ${r.metaDescription ? "✅" : "❌"} | ${r.h1} | ${r.imgsNoAlt} | ${na(r.hreflang)} | ${(p.errors || []).length} |`);
  }
  w("");
  w("> `—` = not expected (noindex page); canonical/JSON-LD/hreflang are only flagged on indexable pages.");
  const allErrs = report.pages.flatMap((p) => (p.errors || []).map((e) => `${p.path}: ${e}`));
  if (allErrs.length) { w(""); w(`### Console / page errors`); allErrs.slice(0, 30).forEach((e) => w(`- ${e}`)); }
  w("");
  w(`## Backlinks`);
  w("");
  if (report.backlinks.configured) {
    w("```json");
    w(JSON.stringify(report.backlinks.data || report.backlinks.error, null, 2).slice(0, 2000));
    w("```");
  } else {
    w(`⚠️ ${report.backlinks.note}`);
  }
  w("");
  return L.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = [];
  if (IP) args.push(`--host-resolver-rules=MAP ${HOST} ${IP}`);
  const browser = await chromium.launch({ args });
  const pages = [];
  for (const p of PATHS) {
    process.stderr.write(`▶ ${p} … `);
    const r = await auditPage(browser, p);
    process.stderr.write(r.ok ? `LCP ${r.lcp}ms CLS ${r.cls}\n` : `FAIL (${r.error || r.status})\n`);
    pages.push(r);
  }
  await browser.close();

  // Real-user field data (CrUX) incl. INP, per page, via PageSpeed Insights.
  if (PSI_KEY) {
    for (const p of pages) {
      if (!p.ok) continue;
      process.stderr.write(`▶ PSI ${p.path} … `);
      p.psi = await psi(p.url);
      process.stderr.write(p.psi?.error ? `err: ${p.psi.error}\n` : `lab ${p.psi?.labScore}\n`);
    }
  }

  const backlinks = await getBacklinks();
  const report = { meta: { base: BASE, ip: IP, host: HOST }, pages, backlinks };

  mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const md = renderMd(report);
  writeFileSync(`reports/perf-${stamp}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`reports/perf-${stamp}.md`, md);
  process.stdout.write(md + `\n\nsaved: reports/perf-${stamp}.{md,json}\n`);
})().catch((e) => { process.stderr.write("PERF AUDIT FAILED: " + e.stack + "\n"); process.exit(1); });
