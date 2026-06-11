// ─────────────────────────────────────────────────────────────────────────────
// SEO + GEO crawler  (the data-collection half of the audit)
//
// Crawls the sitemap, then every internal link/image target, parses each HTML
// head + body, and emits ONE JSON document to stdout. `report.mjs` turns that
// JSON into a readable markdown report — this file does no formatting.
//
//   node crawl.mjs https://example.com > audit.json
//
// Advanced (audit an origin behind a proxy/CDN, or from inside a container):
//   CRAWL_BASE=http://localhost:3000 CRAWL_HOST=www.example.com node crawl.mjs > audit.json
//   CRAWL_BASE is the origin actually fetched; CRAWL_HOST is the Host header +
//   the canonical host used to classify links as internal.
//
// Env:
//   CRAWL_BASE  origin to fetch (default: the positional URL's origin)
//   CRAWL_HOST  Host header / canonical host (default: the positional URL's host)
//   CONC        concurrency (default 12)
// ─────────────────────────────────────────────────────────────────────────────
let argUrl = null;
if (process.argv[2]) { try { argUrl = new URL(process.argv[2]); } catch { /* handled below */ } }
const BASE = process.env.CRAWL_BASE || (argUrl ? argUrl.origin : "");
const HOST = process.env.CRAWL_HOST || (argUrl ? argUrl.host : "");
if (!BASE || !HOST) {
  process.stderr.write("usage: node crawl.mjs <https://your-site.com> > audit.json   (or set CRAWL_BASE + CRAWL_HOST)\n");
  process.exit(1);
}
const CONC = Number(process.env.CONC || 12);

const HEADERS = { Host: HOST, "User-Agent": "seo-geo-audit/1.0 (+https://github.com/lireking/seo-geo-audit)", Accept: "text/html,*/*" };

// same-origin URL → path (or null if external/unparseable)
// HTML attribute values arrive entity-encoded (Next.js renders the image
// optimizer URL as `&amp;w=…&amp;q=…`). Decode before fetching, else the
// optimizer sees an unknown `amp;w` param and 400s every optimized image.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x3D;/gi, "=")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function toPath(u) {
  if (!u) return null;
  u = decodeEntities(u);
  if (u.startsWith("//")) return null;
  if (u.startsWith("/")) return u;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(u)) return null;
  try {
    const url = new URL(u);
    if (url.host !== HOST) return null;
    return url.pathname + url.search;
  } catch { return null; }
}

const fetchPath = (p, redirect = "manual") =>
  fetch(BASE + p, { headers: HEADERS, redirect });

async function pool(items, fn, conc = CONC) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

// ── parse one page ───────────────────────────────────────────────────────────
function parseHtml(path, html) {
  const o = { path };
  const headEnd = html.indexOf("</head>");
  const head = headEnd > -1 ? html.slice(0, headEnd) : html;
  const body = headEnd > -1 ? html.slice(headEnd) : html;
  const cap1 = (re, s = html) => { const m = s.match(re); return m ? m[1].trim() : null; };

  // Scan the WHOLE document for metadata, not just <head>. Next.js can stream a
  // route's metadata into the body (an <AsyncMetadataOutlet>) and relocate it to
  // <head> on the client — so the tag is present + JS crawlers (Google) see it,
  // but JS-less crawlers reading the initial head miss it. We capture the value
  // either way and flag the streamed case distinctly from truly-missing.
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
  o.title = cap1(titleRe);
  o.titleLen = o.title ? o.title.length : 0;
  o.desc = cap1(/<meta\s+name="description"\s+content="([^"]*)"/i);
  o.descLen = o.desc ? o.desc.length : 0;
  o.robots = cap1(/<meta\s+name="robots"\s+content="([^"]*)"/i) || "";
  o.noindex = /noindex/i.test(o.robots);
  o.nofollow = /nofollow/i.test(o.robots);
  o.canonical = cap1(/<link\s+rel="canonical"\s+href="([^"]*)"/i);
  o.htmlLang = cap1(/<html[^>]*\blang="([^"]*)"/i);
  // metadata present in the document but NOT in the initial <head> → streamed
  o.metaStreamedToBody = !!o.title && !titleRe.test(head);

  o.og = {
    title: /property="og:title"/i.test(html),
    image: /property="og:image"/i.test(html),
    description: /property="og:description"/i.test(html),
    type: cap1(/property="og:type"\s+content="([^"]*)"/i),
  };
  o.twitter = /name="twitter:card"/i.test(html);

  // hreflang annotations (Next renders the attr as hrefLang — match case-insensitively)
  o.hreflangs = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]*)"\s+href="([^"]*)"/gi)]
    .map((m) => ({ lang: m[1], href: m[2] }));

  // headings outline (GEO: clear semantic structure helps answer-engines)
  o.headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80) }));
  o.h1 = o.headings.filter((h) => h.level === 1).length;

  // JSON-LD structured data (GEO: machine-readable entities). Scan the WHOLE
  // document for real server-rendered <script type="application/ld+json"> tags.
  o.jsonLd = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const types = (Array.isArray(j) ? j : [j]).flatMap((x) => x?.["@graph"] ? x["@graph"] : [x]).map((x) => x?.["@type"]).filter(Boolean);
      o.jsonLd.push(...types.flat());
    } catch { o.jsonLdInvalid = true; }
  }
  // GEO nuance: if "application/ld+json" only appears inside the RSC flight
  // payload (self.__next_f) and not as a real server-rendered tag, the structured
  // data is injected CLIENT-SIDE — JS-less AI crawlers (GPTBot/ClaudeBot/
  // PerplexityBot) never see it. Flag that distinctly from "truly absent".
  o.jsonLdClientOnly = o.jsonLd.length === 0 && /application\/ld\+json/i.test(html);

  // content depth (GEO): approximate visible word count from body text
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  o.words = text ? text.split(" ").length : 0;

  // links + images
  const links = new Set();
  for (const a of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    const p = toPath(a[1].split("#")[0]);
    if (p && !p.startsWith("/api/")) links.add(p);
  }
  o.links = [...links];
  const imgs = new Set();
  for (const im of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) { const p = toPath(im[1]); if (p) imgs.add(p); }
  o.imgs = [...imgs];
  o.imgsNoAlt = [...html.matchAll(/<img\b([^>]*)>/gi)].filter((m) => !/\balt="/i.test(m[1])).length;

  return o;
}

// ── probe: fetch + (if html) parse ───────────────────────────────────────────
async function probe(path, parse = true) {
  const rec = { path, status: 0, location: null, ctype: "", bytes: 0 };
  let res;
  try { res = await fetchPath(path); }
  catch (e) { rec.error = e.message; return rec; }
  rec.status = res.status;
  rec.location = res.headers.get("location");
  rec.ctype = res.headers.get("content-type") || "";
  rec.xRobots = res.headers.get("x-robots-tag") || null;
  if (rec.status >= 300 && rec.status < 400) return rec;          // redirect, skip body
  if (!/text\/html/i.test(rec.ctype) || !parse) {
    try { rec.bytes = Number(res.headers.get("content-length")) || (await res.arrayBuffer()).byteLength; } catch {}
    return rec;
  }
  let html = "";
  try { html = await res.text(); } catch (e) { rec.error = e.message; return rec; }
  rec.bytes = Buffer.byteLength(html);
  Object.assign(rec, parseHtml(path, html));
  return rec;
}

// ── sitemap ──────────────────────────────────────────────────────────────────
async function readSitemap() {
  const collect = async (p) => {
    const r = await fetchPath(p, "follow");
    const x = await r.text();
    return x;
  };
  const idx = await collect("/sitemap.xml");
  const childMaps = [...idx.matchAll(/<loc>([^<]*sitemap[^<]*)<\/loc>/gi)].map((m) => m[1]);
  const urls = [...idx.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]).filter((u) => !/sitemap/i.test(u));
  for (const cm of childMaps) {
    const p = toPath(cm); if (!p) continue;
    const x = await collect(p);
    urls.push(...[...x.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]));
  }
  return urls;
}

// ── robots.txt + llms.txt (GEO) ──────────────────────────────────────────────
async function geoFiles() {
  const out = {};
  try {
    const r = await fetchPath("/robots.txt", "follow");
    out.robotsStatus = r.status;
    out.robotsTxt = r.status === 200 ? await r.text() : null;
  } catch (e) { out.robotsError = e.message; }
  for (const f of ["/llms.txt", "/llms-full.txt", "/.well-known/llms.txt"]) {
    try { const r = await fetchPath(f, "follow"); out[f] = r.status; } catch { out[f] = 0; }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const sitemapRaw = await readSitemap();
  const sitemapPaths = sitemapRaw.map(toPath).filter(Boolean);
  const counts = sitemapPaths.reduce((a, p) => ((a[p] = (a[p] || 0) + 1), a), {});
  const sitemapDuplicates = Object.entries(counts).filter(([, n]) => n > 1).map(([p, n]) => ({ path: p, count: n }));
  const uniqueSitemap = [...new Set(sitemapPaths)];

  // crawl every sitemap page (full parse)
  const pages = await pool(uniqueSitemap, (p) => probe(p, true));
  const byPath = new Map(pages.map((p) => [p.path, p]));

  // gather every referenced internal target, probe status of the ones not crawled
  const targets = new Set();
  for (const pg of pages) { (pg.links || []).forEach((l) => targets.add(l)); (pg.imgs || []).forEach((l) => targets.add(l)); }
  const extra = [...targets].filter((t) => !byPath.has(t));
  const extraRecs = await pool(extra, (p) => probe(p, false));
  const statusOf = new Map([...byPath].map(([k, v]) => [k, v.status]));
  const recOf = new Map([...byPath]);
  for (const r of extraRecs) { statusOf.set(r.path, r.status); recOf.set(r.path, r); }

  // resolve a target through redirects to its final status (cap 5 hops)
  async function resolveFinal(p) {
    const chain = [];
    let cur = p;
    for (let i = 0; i < 6; i++) {
      let s = statusOf.get(cur);
      let rec = recOf.get(cur);
      if (s === undefined) { rec = await probe(cur, false); statusOf.set(cur, rec.status); recOf.set(cur, rec); s = rec.status; }
      chain.push({ path: cur, status: s });
      if (s >= 300 && s < 400 && rec?.location) { const nx = toPath(rec.location); if (!nx || nx === cur) break; cur = nx; continue; }
      break;
    }
    return chain;
  }

  // per-page outgoing link health
  const linkAudit = [];
  for (const pg of pages) {
    if (pg.status !== 200) continue;
    const broken = [], redirects = [];
    for (const l of pg.links || []) {
      const s = statusOf.get(l);
      if (s === 0 || s === undefined) broken.push({ target: l, status: s ?? null });
      else if (s >= 400) broken.push({ target: l, status: s });
      else if (s >= 300 && s < 400) {
        const chain = await resolveFinal(l);
        const fin = chain[chain.length - 1];
        if (fin.status >= 400) broken.push({ target: l, status: s, final: fin.status, finalPath: fin.path });
        else redirects.push({ target: l, status: s, final: fin.status, finalPath: fin.path });
      }
    }
    const brokenImgs = (pg.imgs || []).map((im) => ({ src: im, status: statusOf.get(im) })).filter((x) => x.status === 0 || x.status >= 400);
    if (broken.length || redirects.length || brokenImgs.length)
      linkAudit.push({ path: pg.path, broken, redirects, brokenImgs });
  }

  const geo = await geoFiles();

  process.stdout.write(JSON.stringify({
    meta: { host: HOST, base: BASE },
    sitemap: { total: sitemapPaths.length, unique: uniqueSitemap.length, duplicates: sitemapDuplicates },
    geo,
    pages,
    statuses: Object.fromEntries(statusOf),
    linkAudit,
  }));
})().catch((e) => { process.stderr.write("CRAWL FAILED: " + e.stack + "\n"); process.exit(1); });
