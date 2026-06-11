# seo-geo-audit

**Dependency-free SEO + GEO audit toolkit.** Four small tools, each one command, each
producing a readable markdown report — built for solo operators who want Ahrefs-style
answers without the subscription.

Born from auditing my own blog, [cloudapp.dev](https://www.cloudapp.dev) — the full story
(and what the toolkit found on its own author's site) is in the launch post:
[An Open-Source SEO + GEO Audit Toolkit in Plain Node](https://www.cloudapp.dev/open-source-seo-geo-audit-toolkit).

**GEO** = Generative Engine Optimization: is your site readable for **AI answer engines**
(ChatGPT, Claude, Perplexity, Google AI Overviews)? Their crawlers mostly **don't execute
JavaScript** — so structured data your framework injects client-side, or metadata streamed
into the body, is invisible to them even though Google sees it. This kit detects exactly
that class of problem. (Why care? Check your analytics — `claude.ai` and
`copilot.microsoft.com` referrers are already showing up in ours.)

| Tool | Question it answers | Command |
|---|---|---|
| [`seo-audit`](#1-seo-audit--crawler--static-html-analysis) | Is the site technically sound — for classic SEO **and** for JS-less AI crawlers? | `seo-audit/run.sh https://your-site.com` |
| [`perf-audit`](#2-perf-audit--core-web-vitals--js-render) | Is it fast (lab CWV + real-user CrUX), and what does the post-hydration DOM look like? | `node perf-audit/perf-audit.mjs https://your-site.com` |
| [`gsc-fetch`](#3-gsc-fetch--search-console-opportunities) | Where are the fastest ranking wins (striking distance, low-CTR winners)? | `node gsc-fetch/gsc-fetch.mjs "sc-domain:your-site.com"` |
| [`umami-fetch`](#4-umami-fetch--on-site-analytics) | What do visitors actually do on-site, and which channels really deliver? | `node umami-fetch/umami-fetch.mjs` |

Everything is plain Node ≥ 18 (`node:fetch`, `node:crypto`), **zero npm dependencies** —
except `perf-audit`, which needs Playwright for the browser. Reports land in `reports/`
as dated `.md` + `.json` pairs, so you can diff runs over time.

---

## 1. seo-audit — crawler + static-HTML analysis

```bash
seo-audit/run.sh https://your-site.com
```

Crawls the sitemap, then **every internal link and image target**, and analyzes the raw
server HTML (the JS-less view — what GPTBot/ClaudeBot/PerplexityBot actually see).

**SEO checks:** sitemap hygiene (4xx/3xx/duplicates in sitemap), titles & meta descriptions
(missing/too long/too short/duplicated), H1 structure, canonicals (missing / pointing at
redirects or 404s), Open Graph & Twitter cards, `html[lang]`, hreflang (incl. self-reference),
broken internal links & images with redirect-chain resolution.

**GEO checks:**
- **JSON-LD injected client-side only** — structured data present after hydration but absent
  from the server HTML → AI crawlers never see it (the most common GEO bug in React/Next apps)
- **Metadata streamed to body** — title/meta present in the document but not in the initial
  `<head>` (Next.js streaming) → JS-less crawlers miss it while Google sees it
- heading-outline sanity (starts at H1, no skipped levels), thin content (<300 words),
  images without alt text
- `robots.txt`: AI-crawler blocks (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, …)
  and missing `Sitemap:` directive
- `llms.txt` / `llms-full.txt` presence

Sample output: [examples/seo-audit-sample.md](examples/seo-audit-sample.md) (a real run).

<details>
<summary>Advanced: audit an origin behind a CDN/proxy, or an app server directly</summary>

`run.sh` fetches the public URL. To crawl a specific origin while keeping the public
host for canonical/link classification (e.g. the app container behind nginx):

```bash
CRAWL_BASE=http://localhost:3000 CRAWL_HOST=www.your-site.com node seo-audit/crawl.mjs > audit.json
node seo-audit/report.mjs audit.json report.md
```
</details>

## 2. perf-audit — Core Web Vitals + JS-render

```bash
npm i playwright && npx playwright install chromium   # one-time
node perf-audit/perf-audit.mjs https://your-site.com "/,/blog,/about"
```

Drives the live site with Playwright (cold load per page) and reports:

- **Lab CWV** — LCP, CLS, FCP, TTFB, TBT, rated against Google's good/poor thresholds
- **Field CWV** — real-user CrUX p75 **including INP** + Lighthouse score, via the free
  PageSpeed Insights API (set `PSI_API_KEY`, see `.env.example`)
- **Performance budget** — requests + transfer bytes by type (JS/CSS/images), DCL/load
- **JS-render view** — the post-hydration DOM (title, JSON-LD, canonical, meta description,
  H1 count, alt-less images, hreflang) plus console/page errors. Compare against
  `seo-audit`'s static view to spot client-only rendering.
- **Backlinks** — pluggable paid provider (Ahrefs wired; honest no-op without a key)

Optional: `PERF_IP=1.2.3.4` pins the hostname to a specific IP (`--host-resolver-rules`) —
useful for flaky DNS or measuring one origin server behind a load balancer.

## 3. gsc-fetch — Search Console opportunities

```bash
node gsc-fetch/gsc-fetch.mjs "sc-domain:your-site.com"
```

Pulls the Search Analytics API (last 90 days by default) and computes the two reports
a solo operator actually acts on:

- 🎯 **Striking distance** — queries at position 5–20 with real impressions, sorted by
  opportunity. A title/H1/content tweak can pull these onto page 1. Highest ROI per hour.
- 📉 **Low-CTR winners** — queries already ranking top-5 but earning fewer clicks than the
  position implies (vs. an expected-CTR curve, with "lost clicks" estimates). Fix the
  title/meta to collect what you're already impressing for.

Plus top queries/pages by clicks and impressions, and a daily trend (in the JSON).

**Auth** (one-time, ~2 min): either an OAuth "Desktop app" client — run `npm run gsc:auth`
once, it mints and stores a refresh token — or a service account added as a (restricted)
GSC user. Both flows are dependency-free; setup steps are in the headers of
[`gsc-auth.mjs`](gsc-fetch/gsc-auth.mjs) / [`gsc-fetch.mjs`](gsc-fetch/gsc-fetch.mjs).

## 4. umami-fetch — on-site analytics

```bash
node umami-fetch/umami-fetch.mjs        # set UMAMI_* in .env.local first
```

The "after the click" half (pairs with `gsc-fetch`'s "before the click"). Pulls a
self-hosted [Umami](https://umami.is) v3 instance and reports: totals, traffic channels
(search/social/direct/internal rollup — the distribution reality check), referrers, top
pages, countries, devices, custom events, UTM campaigns, configured funnels.

Two practical extras built in:

- **Datacenter-adjusted totals** — set `UMAMI_DC_COUNTRIES=SG,HK` to subtract bot-heavy
  countries from pageviews/visitors/bounce as a second "adjusted" row. (Umami's API
  filters are equality-only — no "not equals" — so the tool fetches each suspect country
  and subtracts. In our case one datacenter country was a third of all "visits".)
- **UTM parsing from the query metric** — campaign/source/medium tables even though the
  API exposes no `utm_*` metric type.

## Setup

```bash
git clone https://github.com/lireking/seo-geo-audit && cd seo-geo-audit
cp .env.example .env.local     # fill in only what you use
seo-audit/run.sh https://your-site.com   # works with zero config
```

`.env.local` is gitignored; keys never live in the repo. Each tool also reads plain
environment variables, so everything is cron-/CI-friendly.

## Philosophy

- **One command → one markdown report.** Readable in the terminal, diffable in git,
  pasteable into an issue.
- **No dependencies, no build step.** Plain Node scripts you can read in one sitting and
  edit to your needs — the whole kit is ~1,500 lines.
- **The static-HTML view is the point.** Most SEO tooling renders JS and sees what Google
  sees. AI crawlers don't. Auditing both views — and diffing them — is what GEO needs.

PRs welcome. Scope is deliberately small — these are sharp little knives, not a platform.

## About

Built and maintained by [lireking](https://github.com/lireking). These are the exact
scripts behind the weekly audits of [www.cloudapp.dev](https://www.cloudapp.dev) — a blog
about Home Assistant, Next.js and self-hosting; the toolkit's findings there (streamed
metadata, datacenter bot traffic, a #1 ranking with 0% CTR) are documented in the
[launch post](https://www.cloudapp.dev/open-source-seo-geo-audit-toolkit).

## License

MIT
