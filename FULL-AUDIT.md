# mergers.news — Full-Stack Audit Report
**Date:** 2026-06-13  
**Scope:** All 27 files listed in brief  
**Rating: 7.0 / 10**

---

## Executive Summary

mergers.news is a solidly engineered single-page application with a Bloomberg-Terminal-inspired dark UI, a multi-source ingestion pipeline (SEC EDGAR, EU Merger Registry, HKEX/ASX/SGX, RSS news feeds), and a comprehensive observability layer (MONITOR-pie.js + MONITOR-synthetic.js). The product works and looks professional. The design system in style.css is coherent, the `esc()` sanitisation function in app.js covers the main XSS vectors, and the Vercel security headers in DEPLOY-vercel.json are best-practice.

However, three systemic issues drag the quality rating down from potential 8.5:

**First**, the observability layer is broken in production. pie-health.json (line 89) records `"status":"skip"`, `"message":"Check error: column \"acquirer\" does not exist"` for three critical checks (name_quality, dedup_health, confidence_distribution). These checks errored against the real schema because the monitoring code was written against a different column naming convention. The dashboard shows `overallScore: 100` when at least 3 of 13 checks are silently failing. This is worse than no monitoring — it gives false confidence.

**Second**, deals.json is served as a raw ~7 MB fetch with no pagination, streaming, or CDN caching beyond GitHub's raw CDN. The frontend loads the entire dataset on every page load, blocks the main thread while parsing JSON, and re-renders the full dataset on every filter interaction. The 300-line `esc()` regex chain runs serially on ~10,000+ records. On a 3G connection this is a 10–15 second white screen.

**Third**, FIX-ipo-dynamic-loader.js (lines 134–140 in renderIPOTable) writes `c.name`, `c.sector`, `c.notes`, etc. directly into innerHTML without calling `esc()`. The `esc()` function exists in app.js but is not shared to the IPO page's inline script or to FIX-ipo-dynamic-loader.js. Dynamic IPO data coming from `ipos.json` (a GitHub raw URL) can contain arbitrary HTML/JavaScript that will execute in users' browsers.

Secondary concerns: the filter dropdown state machine (app.js lines 476–519) uses `data-filter` on the outer pills but `data-filter-type` / `data-filter-val` for the inner-section pills — these two systems are never connected, so clicking the outer pill row has no effect on filtering. The ticker bar (DEPLOY-index.html lines 47–58) displays hardcoded, static facts duplicated exactly (items 1–6 repeat identically as items 7–12). The FIX-eu-ingestor.js `runUkCompaniesHouse` function (lines 156–207) fetches a list of UK PLCs but only upserts companies, never creates deals — it burns database calls for zero deal value. The `dedup_health` check in MONITOR-pie.js (lines 300–324) performs a self-join cross-product of the deals table with no index on `(acquirer_id, target_id, created_at)`; this will become a table scan as the dataset grows.

Overall: excellent bones, critical gaps in data integrity visibility, one active XSS vector, and a performance architecture that will not scale past its current size.

---

## Highest-Impact Fixes

### Fix 1 — XSS in IPO Page Dynamic Data
**Problem:** FIX-ipo-dynamic-loader.js lines 134–140 (`renderIPOTable`) write `c.name`, `c.sector`, `c.notes`, `c.statusLabel`, `c.exchange`, `c.expected`, `c.valuation` directly into `innerHTML` with no escaping. The same is true for lines 166–176 (mobile card render) and lines 200–212 (modal content). DEPLOY-ipo.html has the same issue in its own identical script block (lines 481–492, 486–490). Data comes from `ipos.json` on a GitHub raw URL which can be compromised.  
**Why it matters:** A malicious string in any `ipos.json` field renders as live HTML/JS in every visitor's browser — stored XSS at scale.  
**Files:** FIX-ipo-dynamic-loader.js lines 134–140, 166–176, 200–212; DEPLOY-ipo.html lines 481–492.  
**Recommended fix:** Define `esc()` as a module-level function in both the IPO inline script and FIX-ipo-dynamic-loader.js (copy the 8-line version from app.js lines 30–41), then wrap every interpolated value: `esc(c.name)`, `esc(c.notes)`, etc. Also apply `esc()` in the modal `openIPOModal` function (lines 201–212).  
**Difficulty:** Low  
**Expected impact:** Eliminates stored XSS vector from dynamic IPO data.

---

### Fix 2 — Broken PIE Monitoring Checks (Schema Mismatch)
**Problem:** pie-health.json lines 87–112 reveal that `name_quality`, `dedup_health`, and `confidence_distribution` checks return `"status":"skip"` / `"Check error: column X does not exist"`. MONITOR-pie.js `checkNameQuality` (line 229) references `a.name` via a companies join — this works. But `checkDedupHealth` (lines 303–314) references `a.acquirer_id` in a context where the alias resolves differently. `checkConfidenceDistribution` (line 424) queries `d.source_confidence` but the error says `column "confidence" does not exist` — the export aliases it as `"confidence"` but the column is `source_confidence`. Additionally, the overall score reports 100/100 when 7 of 13 checks are skipped, because `notApplicable` returns score 100 and the scoring function excludes `not_applicable` status — but the error-status checks return `score: 50` in the pie-health.json file, which suggests an older version of the monitor ran before the current fix. The bottom line: three health checks silently fail, and the dashboard scores 100/100 as a result.  
**Why it matters:** The entire PIE system is the safety net. A broken safety net is more dangerous than no safety net. Critical data quality degradation (placeholder names, dedup failures) goes undetected.  
**Files:** MONITOR-pie.js lines 229, 303–325, 420–443; pie-health.json (evidence).  
**Recommended fix:** In `checkDedupHealth` (line 303): replace `a.acquirer_id` with `d.acquirer_id` in the join; alias tables consistently. In `checkConfidenceDistribution` (line 424): change `d.source_confidence` to `d.source_confidence` (verify column name against actual schema with `\d deals` in psql). Verify `checkNameQuality` join works end-to-end. Add a CI step that runs `node MONITOR-pie.js` against a test DB and asserts `overallScore < 100` if any check errors.  
**Difficulty:** Low  
**Expected impact:** Restores three critical health checks; enables genuine data quality monitoring.

---

### Fix 3 — 7 MB Synchronous JSON Payload on Every Page Load
**Problem:** app.js line 8 sets `GITHUB_DB = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/deals.json'` with a cache-busting timestamp (`?t=` + Date.now(), line 305). At 13,614+ deals (per pie-health.json velocity data), deals.json is growing past 7 MB. Every page load: fetches 7 MB over the network, parses the entire JSON array synchronously on the main thread, runs the filter pipeline over 10,000+ records. There is no pagination, no streaming, no split by year/sector.  
**Why it matters:** On a typical 3G mobile connection (1.5 Mbps), the raw download is 37 seconds. Even on 4G (25 Mbps) the download is 2.2 seconds. The `?t=Date.now()` cache-buster bypasses both browser cache and GitHub's CDN cache on every load.  
**Files:** app.js lines 8, 305.  
**Recommended fix:** (a) Remove `?t=Date.now()` — use a versioned cache key instead (`?v=YYYYMMDD`) updated only when the file changes. (b) Split deals.json into `deals-recent.json` (last 2 years, ~500 records, <300 KB) served first and `deals-full.json` for on-demand load. (c) In FIX-export-to-github.js, write two files: one with records from `announcement_date >= NOW() - INTERVAL '2 years'` and one with all records. (d) Implement `renderDeals()` virtual scrolling — only build DOM for visible rows.  
**Difficulty:** Medium  
**Expected impact:** Reduces initial load from 7 MB to ~300 KB; eliminates cache-busting overhead; makes the site usable on mobile.

---

### Fix 4 — Filter Pill State Machine Disconnection
**Problem:** app.js lines 476–519 set up two independent filter systems. The outer pills in `deal-table-controls` (DEPLOY-index.html lines 331–335) have `data-filter-type` and `data-filter-val` attributes and are wired to toggle `filterDropdown` visibility (app.js lines 476–483). The inner dropdown pills (DEPLOY-index.html lines 344–381) have `data-filter` attributes and update `state.status`, `state.sector` etc. (app.js lines 487–504). However, the "Apply" button (app.js line 507) then calls `applyFilters()`. This means: clicking an outer pill (e.g. "Sector") opens the dropdown but the pill never shows its selected value; the outer pill label never updates to reflect the active filter; `clearAllFilters()` (line 521) resets the inner pills but the outer pills remain with their original `active` class styling. The user has no feedback about which filters are active.  
**Why it matters:** Core discovery feature is broken UX. Users cannot tell which filters are applied. The outer "Sector" pill stays marked as `active` always — it was the first pill in the HTML with class `active` and never changes.  
**Files:** app.js lines 476–530; DEPLOY-index.html lines 330–388.  
**Recommended fix:** Refactor to a single filter model. Replace the two-level pill system with one row of pills per filter category that update `state` directly and trigger `applyFilters()` on click without requiring a separate "Apply" step. Update each outer pill label to show the active value (e.g. "Sector: Tech"). Remove the dropdown and the "Apply" button.  
**Difficulty:** Medium  
**Expected impact:** Makes filtering discoverable and reliable; removes the most confusing UI pattern on the homepage.

---

### Fix 5 — IPO Page: FIX-ipo-dynamic-loader.js Is Not Applied
**Problem:** DEPLOY-ipo.html contains its own complete inline script (lines 366–end) that duplicates the entire IPO_COMPANIES array and all rendering functions. FIX-ipo-dynamic-loader.js is a separate file with the same data and an improved `renderIPOTable` that fixes the empty-state handling (line 129: shows "No companies match" row instead of broken empty `<tbody>`). But FIX-ipo-dynamic-loader.js's instructions (lines 274–288) say to manually replace the inline script block. There is no evidence this has been applied. Both files have the same IPO_COMPANIES data verbatim — 38 companies across 38 lines. They will diverge.  
**Why it matters:** Two copies of the same 38-company data array will go out of sync. The fixed renderIPOTable (with empty-state handling) is not actually served to users.  
**Files:** DEPLOY-ipo.html lines 384–end; FIX-ipo-dynamic-loader.js.  
**Recommended fix:** Replace the inline `<script>` block at the bottom of DEPLOY-ipo.html with `<script src="/ipo.js"></script>` (or apply the FIX file's instructions). Move IPO_COMPANIES to a separate `ipos-seed.json` file fetched at runtime, eliminating duplication.  
**Difficulty:** Low  
**Expected impact:** Single source of truth for IPO data; fixes empty-state rendering; enables applying XSS fix (Fix 1) in one place.

---

### Fix 6 — SC 13E-3 Role Assignment Bug in SEC Ingestor
**Problem:** FIX-sec-ingestor-index.js lines 362–366 handle `SC 13E-3` and `SC 13E-3/A` by setting both `acquirer` and `target` to `companyName` (the same entity). This is semantically wrong: in a going-private, the filer is typically the issuer (the company going private), not the acquirer. The acquirer is the PE sponsor, which is not the EDGAR entity name. Setting both to the same name produces deals like "Company / Company" in the database.  
**Why it matters:** Every SC 13E-3 record in the database has `acquirer === target`. This is data-quality corruption that affects the 250+ going-private records.  
**Files:** FIX-sec-ingestor-index.js lines 362–366; FIX-enrich-deals.js lines 69–99.  
**Recommended fix:** For SC 13E-3, set `target = companyName` (the company going private), set `acquirer = extractOtherParty(docText, 'SC 13E-3') || 'Acquirer (see filing)'`. Add `SC 13E-3` patterns to `extractOtherParty` targeting "sponsored by", "buyout group led by", or "pursuant to an agreement with". Mark `needs_review = true` and `source_confidence = 0.65` since extraction is harder.  
**Difficulty:** Medium  
**Expected impact:** Fixes data quality for all 250+ going-private records.

---

### Fix 7 — EU Ingestor Wastes Database Calls Ingesting Non-Deals
**Problem:** FIX-eu-ingestor.js lines 156–207 (`runUkCompaniesHouse`) fetches 100 active UK PLCs from Companies House and calls `upsertCompany` for each one — but never creates a deal. It adds `stats.fetched += data.items.length` (line 176) making the stats look inflated, and calls `upsertCompany` 100 times per run for companies that may have no M&A activity. This runs every 12 hours. There is also no authentication header for the Companies House API (line 157) — the UK Companies House API requires an API key for authenticated requests (unauthenticated requests are rate-limited to 600/5 minutes and the response format changed in 2024).  
**Why it matters:** Burns database write capacity; inflates ingestion stats with non-deal data; will begin failing silently when the API key requirement is enforced.  
**Files:** FIX-eu-ingestor.js lines 156–207.  
**Recommended fix:** Remove `runUkCompaniesHouse` entirely from `run()` (line 23) or gate it behind a `COMPANIES_HOUSE_API_KEY` env var and only call it when an actual M&A announcement appears. The Companies House API is not a deal source — it is a company registry. If company enrichment is needed, call it lazily when a company name appears in a deal.  
**Difficulty:** Low  
**Expected impact:** Reduces wasted DB writes; removes inflated ingestion stats; prevents future API failures.

---

### Fix 8 — Missing robots.txt
**Problem:** DEPLOY-vercel.json has no rewrite or route for `/robots.txt`. DEPLOY-sitemap.xml exists but there is no robots.txt file in the project referencing it. Googlebot and other crawlers will receive a 404 for `/robots.txt`, which is treated as "allow all" — but without a `Sitemap:` directive, the sitemap will never be auto-discovered.  
**Why it matters:** Sitemap is never submitted to search engines via robots.txt. Individual deal permalink URLs (`/deal/{id}`) will be crawled as separate pages (the 404.html redirects to `/`, which then opens the modal via sessionStorage — this is not crawlable content), potentially wasting crawl budget.  
**Files:** DEPLOY-vercel.json (missing route); DEPLOY-sitemap.xml.  
**Recommended fix:** Add a `robots.txt` file: `User-agent: * \n Allow: / \n Disallow: /deal/ \n Disallow: /monitoring \n Sitemap: https://mergers.news/sitemap.xml`. Add a Vercel static file or rewrite rule for `/robots.txt`.  
**Difficulty:** Low  
**Expected impact:** Enables sitemap auto-discovery; prevents crawl budget waste on deal permalinks.

---

### Fix 9 — EFTS API Field Mapping Error Produces Garbage Timestamps
**Problem:** FIX-sec-ingestor-index.js line 80 maps `accession_no: hit._source?.period_of_report` — but `period_of_report` is the fiscal period end date of the filed document (e.g. "2025-12-31"), not the accession number. Line 82 maps `filing_date: hit._source?.period_of_report || hit._source?.file_date` — again using `period_of_report` as the primary timestamp. The actual accession number is `hit._id` (which is already captured). So `filing.accession_no` in the ingestion code is actually a date string, not an accession number, and `filing.filing_date` may be the fiscal period end rather than the actual filing date.  
**Why it matters:** The `processFiling` function checks `existing = await db.query('SELECT id FROM filings WHERE accession_no = $1', [cleanAcc])` (line 134) where `cleanAcc` is derived from `filing.id.split(':')[0]` — this is the actual accession number from `hit._id`, not from the incorrectly mapped `accession_no` field. So deduplication still works (it uses the correct `hit._id`), but the `accession_no` stored in the filings table is a date string, making EDGAR URL reconstruction in FIX-export-to-github.js (lines 347–399) fail for these records.  
**Files:** FIX-sec-ingestor-index.js lines 78–87; FIX-export-to-github.js lines 347–399.  
**Recommended fix:** In `fetchRecentFilings`, change line 80 to `accession_no: hit._id.split(':')[0]` and line 82 to `filing_date: hit._source?.file_date`. The `period_of_report` field should not be used as a date for M&A filings (it represents the reporting period, not when the tender offer was filed).  
**Difficulty:** Low  
**Expected impact:** Fixes EDGAR URL reconstruction for newly ingested records; fixes filing_date accuracy.

---

### Fix 10 — No Content Security Policy for Inline Scripts / `unsafe-inline` Too Broad
**Problem:** DEPLOY-vercel.json line 68 sets `Content-Security-Policy` with `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com`. The `'unsafe-inline'` directive allows any inline script to execute, which negates the entire value of CSP against XSS. The homepage (DEPLOY-index.html lines 23–26) uses inline `<script>` for Google Analytics initialization which requires `'unsafe-inline'` — but this could be replaced with a nonce-based approach. The same CSP also allows `connect-src: 'self' https://raw.githubusercontent.com` which is correct, but also allows `https://www.googletagmanager.com` in `connect-src` enabling GTM to load arbitrary scripts.  
**Why it matters:** CSP's primary value against XSS is nullified by `'unsafe-inline'`. Combined with the unescaped IPO innerHTML (Fix 1), this means CSP provides zero protection against that XSS vector.  
**Files:** DEPLOY-vercel.json line 68.  
**Recommended fix:** Replace `'unsafe-inline'` with per-page nonces via Vercel Edge Middleware. For the GA script, move initialization to an external `/analytics.js` file loaded with `async defer`. For the inline GA init snippet, use a nonce: `<script nonce="GENERATED_NONCE">`. Remove `https://www.googletagmanager.com` from `connect-src` (GTM's own script tag handles this). The bottom-nav `<style>` tags inside `<body>` in DEPLOY-index.html (lines 709–760) and DEPLOY-ipo.html also require `'unsafe-inline'` in `style-src` — move these to style.css.  
**Difficulty:** Medium  
**Expected impact:** Meaningful XSS protection via CSP; enables detection of injected scripts.

---

## UI Audit

### Layout
The layout uses a `max-width: 1400px` container (style.css line 399) with `padding: 0 var(--s6)` (24px). The homepage is well-structured: ticker → fixed header → hero → KPI cards → chart → table → industry grid → filing types → trust section → learn section. However:

- **Hero grid** (style.css line 418): `grid-template-columns: 1fr 380px` has no responsive breakpoint definition in style.css. The mobile breakpoint should collapse this to a single column, but I cannot confirm this without seeing the full responsive CSS section (the style.css file appears to be read to ~900 lines — see below for media queries).
- **Bottom nav** (DEPLOY-index.html lines 709–804): The bottom nav `<style>` block is embedded inside `<body>` instead of the `<head>`. While this works, it causes FOUC (Flash of Unstyled Content) because styles apply after rendering begins. Move to `<head>` or to style.css.
- **Header padding** (app.js lines 57–62): `updatePadding()` sets `paddingTop = h.offsetHeight + 28 + 12`. The `+28` accounts for the ticker bar height. This is fragile — if the ticker bar height changes (e.g. on mobile where the ticker wraps), the padding calculation will be wrong. The ticker bar height is also hardcoded in style.css line 107 as `28px`. These should be the same constant.

### Component Consistency
There are two distinct header implementations:
1. **Homepage** (DEPLOY-index.html): uses CSS classes `nav-link`, `logo-wordmark`, `header-nav`, all defined in style.css
2. **Subpages** (DEPLOY-ipo.html, DEPLOY-about.html, DEPLOY-tender-offers.html): use `header-nav-btn` (not defined in style.css — this is an inline style class added directly to `<a>` elements), `header-top` (not defined in style.css), and replicate logo markup with inline styles

The subpage headers have no `<button class="search-trigger">` (the command palette trigger). Users on subpages cannot open the command palette via Cmd+K, as `setupCmd()` looks for `document.getElementById('searchTrigger')` (app.js line 97) which does not exist on subpages. The `if (!trigger) return;` guard on line 97 silently exits without wiring up the palette.

The `mobile-search-btn` trigger also only exists on the homepage. This means mobile search is unavailable on all subpages.

### Visual Hierarchy
The design system token set (style.css lines 9–67) is comprehensive and well-named. Typography scales correctly with `clamp(36px, 4vw, 56px)` on the hero title. Section headers use `font-size: 9px` uppercase mono for labels which is legible at desktop but will be extremely small (effectively 8px rendered) on low-DPI mobile screens.

The deal table `th` elements use `font-size: 8px` (style.css line 820) — this is borderline illegible without letter-spacing. The letter-spacing of `2px` on 8px text brings it to an acceptable minimum but only on high-DPI screens.

### Color System
The color system is internally consistent. `--red: #c8102e` against `--bg: #07080a` passes WCAG AA for large text (contrast ratio ~5.8:1) but fails for small text (<18px). The `--muted: #6b7280` on `--bg` has a contrast ratio of approximately 3.2:1, which fails WCAG AA (requires 4.5:1 for normal text). This affects: deal type/sector cells, date cells, all mono label text.

The `--text2: #a8a29e` on `--bg` has approximately 4.1:1 contrast — passes AA for large text but marginally fails for normal text.

### Spacing
The spacing token set (`--s1` through `--s16`) is used consistently throughout style.css. The `--s6: 24px` container padding is appropriate.

### Cards
Deal cards (mobile view, app.js lines 757–770) and industry cards (DEPLOY-index.html lines 471–527) have consistent structure. The industry cards use `onclick="filterBySector(...)"` inline handlers for Energy, Consumer, Telecom, and Media (lines 492–513) but use `<a href="...">` for Technology, Healthcare, Financial Services, and Tender Offers (lines 471–491, 520–525). This inconsistency means keyboard navigation (Tab + Enter) does not work on the onclick cards, and they do not benefit from browser link prefetching.

### Navigation
The homepage header navigation (DEPLOY-index.html lines 74–83) is semantic `<nav>` with `aria-label="Main navigation"` — correct. The active state uses class `active` (line 75). On subpages (DEPLOY-ipo.html line 52), the same nav structure uses `class="header-nav-btn"` which is not defined in style.css — so there is no hover/active styling from the shared CSS. The subpage `active` class (line 55) uses `class="header-nav-btn active"` — also unstyled.

The mobile bottom nav (DEPLOY-index.html lines 707–804) correctly hides/shows via JS. However, the Search item (lines 771–778) is a `<button>` but has no event listener in DEPLOY-index.html. The `mobileSearchBtn` listener is wired in app.js line 116, which only works on pages that load app.js. Subpages do not load app.js.

### Buttons
All action buttons in style.css use `border: none; background: none` reset and `cursor: pointer`. The hero search button (style.css lines 499–512) has proper hover state. The "Load More" button (app.js lines 672–678) has a correct pattern. The `exportBtn` (DEPLOY-index.html line 317) is an `<a href="#">` styled as a link — clicking it calls `exportCSV()` but does not prevent default. The `#` href means clicking it jumps to the top of the page before the CSV downloads, causing a brief scroll flash.

Fix: Change `<a href="#" class="section-link" id="exportBtn">` to `<button class="section-link" id="exportBtn">` or add `event.preventDefault()` to the click handler.

### Forms
The hero search input (DEPLOY-index.html lines 196–199) and deal table search (lines 325–328) have `aria-label` attributes. Both use `placeholder` text that disappears on focus. Neither has a visible `<label>` element, which technically fails WCAG 1.3.1. The `aria-label` attribute provides programmatic labeling but there is no visible label.

The contact form (referenced in footer but not audited in full — DEPLOY-contact.html not fully read) uses Formspree. Formspree is in the CSP `connect-src` (DEPLOY-vercel.json line 68) and `form-action` (same line), which is correct.

### Modal
The deal modal (DEPLOY-index.html lines 676–704) uses `role="dialog" aria-modal="true" aria-label="Deal details"`. The modal trap does not implement focus trapping: when the modal opens, `overlay.focus()` is called (app.js line 841) but Tab navigation will escape the modal to the background content. A proper focus trap loop is needed. The modal close button (line 679) has `aria-label="Close deal details"` — correct.

The modal's `history.pushState` (app.js line 847) creates shareable URLs at `/deal/{id}`. The `popstate` handler (app.js lines 1141–1159) correctly restores modal state on back navigation. However, if a user shares the URL `/deal/{uuid}` and opens it directly, the 404.html (DEPLOY-404.html lines 8–16) runs `sessionStorage.setItem('pendingDealId', m[1])` and redirects to `/`. But app.js line 1137 reads `window._pendingDealId` from a URL regex match — not from sessionStorage. The 404 approach sets sessionStorage but app.js never reads sessionStorage. The `_pendingDealId` from sessionStorage is never consumed. Direct deal URL sharing is broken.

Fix: In app.js `handleUrlParams()` (lines 1127–1138), add: `if (!window._pendingDealId) { try { var sid = sessionStorage.getItem('pendingDealId'); if (sid) { window._pendingDealId = sid; sessionStorage.removeItem('pendingDealId'); } } catch(e) {} }`.

### Tables
The deal table (`role="table"`) and its `<tbody id="dealList" role="list">` (DEPLOY-index.html line 438) has a role conflict: `<tbody>` cannot have `role="list"` while `<table>` has `role="table"`. Remove `role="list"` from the tbody.

The table has no sortable column headers. The `sortable` class is defined in style.css line 827 but no column headers in the actual HTML use it. Users cannot sort by clicking column headers — they must use the filter dropdown sort pills.

### Article Pages
The "Learn" section (DEPLOY-index.html lines 605–634) has three learn cards with titles, descriptions, and reading time. These cards have no links — they appear to be placeholder content with no target URLs. Clicking them does nothing.

### Loading/Empty/Error States
- Loading skeleton: well-implemented (DEPLOY-index.html lines 396–403), matches table structure
- Error state: displays retry button — correct (lines 405–413)  
- No-results state: displays "Clear filters" button — correct (lines 415–423)
- Hero feed loading: skeleton items with correct dimensions (lines 239–253)
- IPO page loading: no loading state — table tbody is empty until JS runs, showing an empty table with header but no rows

---

## UX Audit

### First Impression
The homepage loads with a Bloomberg-style dark design, live clock, and pulsing LIVE badge. These are strong trust signals for the target finance professional audience. The hero stat counters ("10,000+ Deals Tracked", "$12T+ Total Value") are correct in principle but the $12T figure is a hardcoded static value (DEPLOY-index.html line 221) not computed from the actual database.

### User Intent Clarity
The page clearly communicates "free M&A database from SEC filings." The hero subtitle (line 187–190) is excellent: specific, credible, no registration pitch. The "no registration required" repetition reinforces the value proposition. The `<noscript>` fallback (lines 859–874) provides meaningful content for crawlers and users without JS.

### Navigation Paths
The main navigation has 8 items (Deals, IPO Watch, Technology, Healthcare, Financial, Filings, About, Contact). For desktop at 1400px this works. At 900–1100px, the nav will overflow without wrapping — there is no responsive collapse (hamburger menu). The `header-nav` uses `flex-wrap: nowrap` implicitly (display:flex, no wrap set) and `white-space: nowrap` on nav items (style.css line 211), so at 900px items will overflow off-screen.

No hamburger menu exists for desktop-medium breakpoints. The mobile bottom nav only appears below 768px.

### Content Discovery
The industry grid (DEPLOY-index.html lines 462–528) is the primary content discovery mechanism beyond search. Four sectors (Energy, Consumer, Telecom, Media) use `onclick` handlers that filter the current page's deal table, while three sectors (Technology, Healthcare, Financial) link to dedicated sector pages. This inconsistency confuses users about whether clicking "Energy" will take them to a new page or filter in place.

The command palette (Cmd+K) is a power-user feature that works well on the homepage. Its deal search results (app.js lines 200–231) display up to 8 matches with sector and date metadata. The "Search all deals for..." option (lines 225–229) correctly falls through to the full filter.

### Trust Signals
The trust section (DEPLOY-index.html lines 573–600) explicitly compares to Bloomberg/PitchBook pricing. "SEC EDGAR" as the data source and direct filing links on each deal are strong credibility markers. The footer disclaimer ("Not financial advice") is present and correct.

### Friction Points
1. Users on subpages cannot open the command palette (no search trigger in subpage headers)
2. The filter dropdown requires two clicks to apply filters (open dropdown → select → click Apply)
3. The deal modal's "View SEC Filing" button links to the EDGAR document — this is correct behavior but many EDGAR documents are HTML files that render poorly without the EDGAR framing
4. Export CSV button causes a scroll-to-top flash (href="#" issue noted above)

### Mobile Usability
The bottom nav is well-designed with proper safe-area-inset-bottom padding (DEPLOY-index.html line 721). Mobile cards (app.js lines 750–792) show the correct fields. However:
- Mobile cards have no search bar above them — the deal-table-controls search wrap is only shown when `dealTableWrap` is visible
- The `renderDeals()` function (app.js line 641) checks `window.innerWidth < 768` at render time to decide mobile vs desktop, but this does not update on resize until a `resize` event fires — and the resize handler (app.js line 1166) calls `renderDeals()` again, which re-renders the full list

### Accessibility
- Skip link is present (DEPLOY-index.html line 40) — correct
- Live region on deal count: `aria-live="polite"` on `dealCountText` (line 392) — correct
- `aria-hidden="true"` on ticker bar (line 43) — correct
- `role="search"` on hero search (line 193) and deal table search (line 323) — correct
- Focus management: Cmd+K opens command palette and focuses input (app.js line 75) — correct
- Modal focus: opens overlay and focuses it (line 841) but no focus trap
- `<table role="table">` with correct `<thead>` / `<tbody>` structure
- Industry cards use `<a href>` for 4 items but `<a onclick>` for others — keyboard Enter works on href but requires JS-connected onclick to work with keyboard
- `aria-label` on all major interactive elements — good coverage

### Edge Cases
- No internet: service worker (FIX-sw.js) returns cached pages and `[]` for deals.json. `loadDeals()` will then call `showError()` because the cached response is `'[]'` which is a valid fetch but returns an empty array — app.js line 312 throws `new Error('Empty')`, triggering the error state correctly
- Very long headlines: `esc()` does not truncate. A 500-character headline from the DB would overflow the deal table headline cell. No max-width / overflow:hidden / text-overflow:ellipsis is set on `.deal-headline-cell .headline` (style.css line 843)
- All-filter + large dataset: when `isFiltered = false`, `renderDesktopTable` renders only `PAGE_SIZE (50)` records. When `isFiltered = true`, it renders ALL `filteredDeals` without limit (app.js line 661). A filter that matches 8,000 records will attempt to render 8,000 `<tr>` elements synchronously — DOM freeze.

---

## Ingestion System Audit

### Pipeline Overview
```
EDGAR EFTS API → fetchRecentFilings() → processFiling() → upsertCompany() + insertDeal()
EU Competition API → parseEuJsonCases() → processEuCase() → insertDeal()
UK Companies House → processUkCompany() → upsertCompany() [NO DEALS]
HKEX List HTML → parseHkexAnnouncements() → processHkexAnnouncement() → insertDeal()
ASX HTML → parseAsxAnnouncements() → processAsxAnnouncement() → insertDeal()
SGX HTML → parseSgxAnnouncements() → processSgxAnnouncement() → insertDeal()
RSS Feeds (4) → parseRssItems() → isMaDeal() → processNewsItem() → insertDeal()
→ FIX-scheduler-v2.js: cron jobs → Export → PostgreSQL → deals.json → GitHub
```

### Stage 1: SEC EDGAR (FIX-sec-ingestor-index.js)

**Current implementation:** Uses EDGAR EFTS full-text search API (`efts.sec.gov/LATEST/search-index`). Processes 6 filing types. `fetchFilingDetail()` calls `data.sec.gov/submissions/CIK...json` for company metadata. `fetchFilingText()` fetches first 40KB of the actual document for party/value extraction.

**Failure modes:**
- The `accession_no` field mapping bug (Fix 9 above): `hit._source?.period_of_report` is a fiscal date, not an accession number. This corrupts EDGAR URL reconstruction for all newly ingested records.
- `document_url` field (line 85): set to `hit._source?.file_date` — a date string, not a URL. This means `fetchFilingText(detail?.document_url || '')` on line 144 will call `fetchFilingText('')` and get an empty string on the first ingestion path. The filing text fetch only works if `fetchFilingDetail` succeeds and returns a `document_url`.
- `fetchFilingDetail()` (lines 182–206): uses `accessionNo` parameter which is `filing.id` (the hit._id with colon suffix). Line 185 calls `.split(':')[0]` to clean it — this is correct. But then line 193 uses `findIndex` on `filings.accessionNumber` comparing against `cleanAccession` — the EDGAR submissions JSON uses `filings.recent.accessionNumber` as an array. This will work when the filing appears in the `recent` array, but older filings (beyond the 40-entry recent array limit) return `idx < 0` and only return `{ company_name, sic }` without `document_url`.

**Data-quality risks:**
- Entity extraction via regex (lines 241–296): the patterns use greedy `{2,60}` matching that can grab trailing context. E.g. "merger with ABC Corp in connection with" — the pattern `merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}...)` will match "ABC Corp in connection with" because the trailing text starts with a space. The stop condition relies on the named entity suffix (Inc., Corp., etc.) being present.
- Deal value extraction (lines 300–330): uses highest candidate value (`Math.max(...candidates)`) — correct for transaction value but could grab a penalty or termination fee amount if larger than the deal value itself.

**Missing guards:**
- No retry on 429 (EDGAR rate limit). SEC rate limits to 10 requests/second. The ingestion loop has no `sleep()` between EDGAR calls.
- No circuit breaker: if EDGAR EFTS returns 503, the entire filing type batch fails but processing continues to the next type.
- No deduplication by CIK+filing-date (only by accession number): if the same deal is filed with a `/A` amendment, it creates a new record.

**Recommended fixes:**
1. Fix `accession_no` field mapping (see Fix 9)
2. Fix `document_url` field: change line 85 to `document_url: hit._source?.file_date ? null : null` — the document URL must come from `buildEdgarUrl` or `fetchFilingDetail`, not from hit._source
3. Add `await sleep(100)` between filing fetches to respect SEC rate limits
4. Add retry with exponential backoff for 429/503 responses in `fetchJson`

**Tests to add:**
- Unit: `extractOtherParty(text, 'DEFM14A')` returns correct acquirer for 5 real filing excerpts
- Unit: `extractDealValueCents(text)` does not return termination fee amount when higher than deal value
- Integration: run `processFiling()` against a mock EDGAR response; assert no exception, correct `acquirer/target` populated

### Stage 2: EU Merger Registry (FIX-eu-ingestor.js)

**Current implementation:** Fetches from `competition-cases.ec.europa.eu/search?...procedureType=M`. Parses flexible JSON response. `parseEuCaseTitle` splits on " / " or "/" to extract parties.

**Failure modes:**
- The EC portal URL (line 36) may change without notice — the EC competition portal has changed URLs multiple times. The comment on line 35 ("EC moved to competition-cases.ec.europa.eu") suggests this already happened once.
- `parseEuCaseTitle` (lines 137–153) splits on first "/" or " / " which fails for case titles like "Bertelsmann / Pearson / X" (three-party mergers). The third party is silently dropped.
- EU cases have `needs_review: true` and `deal_value: null` — there is no enrichment path for EU cases because `FIX-enrich-deals.js` targets SEC filings with `edgar_url` (line 169). EU deals with placeholder names will remain unenriched.

**Recommended fixes:**
1. Add health check that verifies EU portal returns parseable JSON within 30s
2. Handle multi-party EU mergers: if more than one "/" exists, store all parties in `target` as a comma-separated list
3. Add EU-specific enrichment: fetch `https://ec.europa.eu/competition/elojade/isef/case_details.cfm?proc_code=2_M_{id}` to extract deal value from the case detail page

### Stage 3: APAC (HKEX, ASX, SGX) (FIX-apac-ingestor.js)

**Current implementation:** Scrapes HTML from exchange announcement pages. HKEX uses dated list pages. ASX uses announcements landing page. SGX scrapes main page.

**Failure modes:**
- ASX URL `announcements.asx.com.au/asxannouncements.asx` (line 162) is not the correct current ASX API endpoint. The current ASX API is `https://www.asx.com.au/asx/1/company/{ticker}/announcements` (JSON) or the ASX market announcements page. The `.asx` file extension endpoint was deprecated.
- HKEX date list URL (lines 42–44): constructs from `todayStr()` / `yesterdayStr()` using format `YYYYMMDD` split into `year/mmdd`. This assumes HKEX never changes their URL structure. The correct current HKEX news URL is `https://www1.hkexnews.hk/listedco/listconews/sehk/{YYYY}/{MMDD}/LIST.HTM` — this matches the code.
- SGX announcement page (line 273) is a JavaScript-heavy SPA. Raw HTTP fetch will return the shell HTML without announcement data, so `parseSgxAnnouncements` will find 0 announcements every time.
- All APAC records have `sector: 'Asia Pacific'` (lines 144, 257, 358) — this is not a valid sector, it is a region. The sector column gets a geolocation value instead of an industry.

**Recommended fixes:**
1. Replace ASX URL with correct current endpoint or use ASX's official announcement API with proper authentication
2. For SGX: use SGX's official API (`https://api2.sgx.com/sites/default/files/non-listed-company-announcements/...`) instead of scraping the SPA
3. Set `sector: null` and `region: 'Asia Pacific'` for APAC records (requires schema has separate `region` column — check)

### Stage 4: RSS News Feeds (FIX-news-ingestor.js)

**Current implementation:** Fetches 4 RSS feeds (GlobeNewswire M&A, PR Newswire M&A, BusinessWire M&A, GlobeNewswire IPO). Applies strong/weak keyword matching plus `EXCLUDE_KEYWORDS`. Extracts entities via 5 regex patterns.

**Failure modes:**
- The `ENTITY_PATTERNS` (lines 84–90) only extract entities from the title. Items with no acquisition pattern in the title but M&A in the description will pass `isMaDeal()` (which checks both title+description) but `extractEntities` returns null/null. These are stored with `acquirer: 'Unknown'` (line 202).
- All 4 feeds are processed in series with 1.5s sleep between them (lines 118–123). If any feed times out (30s timeout in `fetchText`), the subsequent feeds are delayed.
- GlobeNewswire IPO feed (line 27) should never match M&A keywords and wastes processing — unless the intent is to capture reverse mergers announced via IPO press releases.
- No backfill: if the news ingestor is down for >2 hours (the cron interval), those items are permanently missed because the RSS feed only shows recent items.

**Recommended fixes:**
1. Add entity extraction from description field, not just title
2. Remove GlobeNewswire IPO from M&A feed processing — add separate IPO processing path
3. Add `LOOKBACK_HOURS` config: on restart, fetch and re-process items from the last N hours

### Stage 5: Enrichment (FIX-enrich-deals.js)

**Current implementation:** Queries deals with placeholder acquirer/target names. Fetches the filing document. Re-extracts party names and deal values.

**Failure modes:**
- For SC 13E-3 records: `extractOtherParty` is called for both acquirer fix (line 182) and target fix (line 193) using the same `text` and `ft`. Since `ft` is `SC 13E-3`, and the extraction patterns use `[...pDEFM, ...pSCTOT]` (line 88), both fixes will extract the same party name, resulting in acquirer === target again.
- No rate limiting between EDGAR document fetches (only the outer `sleep(DELAY)` at line 212). Multiple deals sharing the same filing (e.g. two records from the same SC TO-T amendment) will each trigger a fetch.

### Stage 6: Deduplication (Referenced in scheduler, no separate file audited)
The scheduler (FIX-scheduler-v2.js line 175) references `./services/deduplication/index` which is not in the audited file set. The `checkDedupHealth` in MONITOR-pie.js (lines 300–324) detects near-duplicates by exact company name match within 6-hour window. This will miss cross-source duplicates (same deal from SEC + news RSS with slightly different company name spellings).

### Stage 7: Export (FIX-export-to-github.js)

**Current implementation:** Queries all deals from PostgreSQL with lateral joins for sources/filings. Generates formatted deal objects. Deduplicates by headline. Pushes base64-encoded JSON to GitHub API.

**Failure modes:**
- Deduplication by headline (lines 155–161): uses exact headline string match. Two records for the same deal with different headlines (one from SEC: "ABC Corp / XYZ Inc", one from news: "ABC Corp acquires XYZ Inc for $2B") will both be exported.
- The GitHub token (`GITHUB_TOKEN`) is used as a `token` type (line 449). GitHub deprecated `token` auth in 2021 in favor of `Bearer`. The correct header is `Authorization: Bearer ${GITHUB_TOKEN}`.
- No file size guard: if deals.json grows beyond GitHub's 100MB file limit, the push will fail silently (the error is caught and logged but no alert fires).
- `JSON.stringify(deduped, null, 2)` uses 2-space indentation, adding ~15% to file size. Use `JSON.stringify(deduped)` (no indentation) for production.

**Recommended fixes:**
1. Deduplicate by `(acquirer_id, target_id, announcement_date)` in the SQL query rather than by headline in JS
2. Change `token` to `Bearer` in GitHub API Authorization header
3. Add file size check before push: if `json.length > 50_000_000` (50MB), split into `deals-recent.json` and `deals-archive.json`
4. Use `JSON.stringify(deduped)` — no indentation

### Stage 8: Scheduling (FIX-scheduler-v2.js)

The scheduler is a single long-running process with `process.stdin.resume()` to keep it alive. It uses boolean `flags` to prevent concurrent runs. 

**Issues:**
- `safeRun` utility function (lines 24–38) is defined but never used — all cron jobs inline their own flag check and require pattern, duplicating the guard logic
- The startup staggered timeouts (lines 226–252) run ingestors at t=2s, 15s, 30s, 45s, 60s. If the process restarts frequently (e.g. Railway restart on OOM), these all fire simultaneously on each restart
- No health check endpoint: there is no HTTP server in the scheduler process, so Railway cannot verify liveness via HTTP probe
- GDELT ingestor (lines 62–74) is referenced in the scheduler but `FIX-gdelt-ingestor.js` was not in the audited file set — existence unconfirmed

---

## Frontend/Data Contract Audit

### Missing title (d.headline is null/undefined)
**Covered:** app.js line 734 falls back to `d.acquirer + ' / ' + d.target`. If both are also null, produces "undefined / undefined". The `esc()` function handles null via the `if (s == null) return ''` guard (line 31) — so the cell displays empty string, not "undefined". Safe.

### Missing/broken image
Not applicable — the frontend displays no images. All article content is text-only.

### Missing source URL
**Covered:** `buildRowInner` (app.js line 744) checks `filingUrl && filingUrl !== '#'` and renders a plain text span instead of a link. `safeUrl` (lines 42–47) returns `'#'` for missing/invalid URLs. `populateModal` (line 895) renders "No Filing URL" text. Safe.

### Missing date
**Covered:** `d.date || String(d.year || '—')` pattern appears in 6 places. If both are missing, displays `'—'`. Safe.

### Invalid URL in sourceUrl
**Covered:** `safeUrl()` (lines 42–47) validates against `^https?://` or `/`. URLs that fail validation return `'#'`. But `safeUrl` only runs on `d.sourceUrl || d.edgarUrl` — it does not validate URLs inside `d.body` or `d.summary` text fields that might contain raw HTML links from the enrichment pipeline.

### Duplicate articles
The `loadDeals()` filter (app.js lines 320–330) removes records with non-M&A deal types and script injection attempts, but does NOT deduplicate by headline or by acquirer+target+date. FIX-export-to-github.js deduplicates by headline before exporting (lines 155–161), but the dedup is headline-exact and the `recordScore` function preserves the record with the highest completeness score. This is adequate but misses same-deal records with different headlines.

### Empty summaries
**Covered:** `populateModal` (app.js line 966) checks `d.body && d.body.trim()`, then `d.summary && d.summary.trim()`, then `d.subheadline`, and finally hides the section (line 981) if all are empty. Safe.

### Overlong titles
**Not covered:** No truncation applied to `d.headline` in the table render (app.js line 734). A 400-character headline from the DB would break the table layout. Add CSS `max-width` + `overflow: hidden` + `text-overflow: ellipsis` to `.deal-headline-cell .headline` in style.css.

### Weird characters / bad HTML
The `esc()` function (app.js lines 30–41) escapes `&`, `<`, `>`, `"`, `'`, `` ` `` and blocks `javascript:`, `data:`, `vbscript:` URL schemes. This is correct. However, the `d.body` field is rendered via:
```javascript
summaryText.innerHTML = leadHtml + d.body.split('\n\n').map(function(para) {
  return '<p style="margin-bottom:10px">' + esc(para.trim()) + '</p>';
}).join('');
```
(app.js line 970–972). `esc(para.trim())` is correct. But `leadHtml` (line 967) uses `esc(d.summary)` — also correct. The entire modal body render is properly escaped. Safe.

### Slow API response
The service worker (FIX-sw.js lines 61–68) uses network-first for navigation and falls back to cache. For `raw.githubusercontent.com` (the deals.json host), the SW uses network-only with `[]` fallback (lines 47–53). If GitHub is slow, there is no timeout in `loadDeals()` (app.js lines 303–338) — a stalled fetch will leave the loading spinner forever until the browser's default fetch timeout (~5 minutes). Add a `setTimeout` abort controller.

### Partial ingestion failure
If the GitHub push in `FIX-export-to-github.js` fails mid-write (line 463–494), GitHub's API is transactional at the file level — either the PUT succeeds or fails. No partial state is possible. Safe.

---

## Code Quality Audit

### Dead Code
- `safeRun` utility in FIX-scheduler-v2.js (lines 24–38): defined but never called. The pattern is repeated inline in each cron callback.
- `gdeltRunning`, `dedupRunning`, `extractRunning` boolean flags (FIX-scheduler-v2.js lines 16–19): declared at module level but `flags` object (lines 41–44) is actually used in the cron callbacks. The individual `let` declarations are dead code.
- `esc(item.dataset.q || '')` in `handleCmdItem` (app.js line 184–191): the search action only calls `closeCmd()` and updates `state.search` — it never injects into HTML, so `esc()` is unnecessary here (though harmless).

### Duplicated Components
- **IPO data array**: Identical 38-entry `IPO_COMPANIES` array exists in both DEPLOY-ipo.html (lines 384–428) and FIX-ipo-dynamic-loader.js (lines 36–80). 
- **Bottom nav HTML**: Identical `<nav class="bottom-nav">` block (with embedded `<style>`) repeated verbatim in DEPLOY-index.html (lines 707–804), DEPLOY-ipo.html (lines 239–331). This is 95 lines of duplicated HTML per page. Should be a shared component.
- **`normalizeName()` function**: Defined separately in FIX-news-ingestor.js (line 278), FIX-eu-ingestor.js (line 234), FIX-apac-ingestor.js (line 451), FIX-enrich-deals.js (line 114). The implementations are nearly identical but differ on one detail: FIX-eu-ingestor.js and FIX-apac-ingestor.js include `sa|ag|nv|bv|se` in the suffix strip (line 239), while FIX-news-ingestor.js and FIX-enrich-deals.js do not. This inconsistency means the same company might normalize to two different strings depending on which ingestor found it first.
- **`insertDeal()` function**: Defined separately in FIX-news-ingestor.js (line 310), FIX-eu-ingestor.js (line 266), FIX-apac-ingestor.js (line 483). The FIX-sec-ingestor-index.js has its own version (line 429) with different field ordering. These should be a shared `db-utils.js` module.
- **`upsertCompany()` function**: Same pattern — 4 separate implementations.
- **`startLog()` / `endLog()` functions**: Same pattern — 4 separate implementations.

### Overcomplicated Logic
- `renderHeroFeed()` (app.js line 429): uses `allDeals.indexOf(d)` inside `onclick="openModal(allDeals[...])` — this searches the full array by reference for each of 6 items. Use data attributes and event delegation instead.
- `updatePadding()` (app.js lines 57–62): could be simplified with `position: sticky` CSS, eliminating JS-calculated padding entirely.

### Poor Naming
- `FIX-*` and `DEPLOY-*` file prefixes indicate these are in a staging state, not deployed. Using different naming conventions for the same codebase is confusing.
- Variable shadowing: in `applyFilters()` (app.js lines 588–590), `var ad` and `var bd` are redeclared inside different `if` branches in the same function scope — this is valid ES5 due to function-scoped `var` but visually confusing.

### Fragile Async Logic
- `FIX-sec-ingestor-index.js` processes filings in a `for...of` loop with `await` (line 40) — sequential, which is safe but slow. With 100 filings per type × 6 types, and each filing requiring 2 HTTP calls + DB writes, a full run could take several minutes. No timeout on the overall run.
- `FIX-enrich-deals.js` `fetchText` (lines 37–57) handles 301/302 redirects recursively but does not pass HTTPS/HTTP module correctly — it always uses `https.get` regardless of redirect destination protocol (line 38: `const req = https.get(...)`). HTTP redirects from EDGAR will fail.

### Missing Validation
- `FIX-api-service.js` `paginate()` (lines 83–89): validates page and limit, but `date_from` / `date_to` (lines 228–229) are passed directly to PostgreSQL without date format validation. A value like `"'; DROP TABLE deals;--"` would be parameterized safely (it's `$N`), but `"2026-13-40"` (invalid date) would cause a PostgreSQL error.
- `FIX-api-service.js` `/api/deals/:id` (line 276): validates UUID format — correct. But the UUID regex `/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i` allows uppercase UUIDs which the DB stores lowercase — the ILIKE comparison would still work since it's string equality.

---

## Performance Audit

### Bundle Size
- `app.js` is ~1,185 lines of vanilla ES5 JavaScript, unminified. Estimated ~42KB unminified.
- `style.css` is 900+ lines (the read was limited to 900 lines but the file is larger based on the included content), unminified. Estimated ~35KB.
- No bundling or minification in the pipeline. Vercel compresses with gzip automatically, but source is sent uncompressed to Vercel's CDN for the initial push.
- The 3 Google Fonts families (Playfair Display, IBM Plex Mono, DM Sans, style.css line 6) load 4 font variants across 2 CDN calls. Each font call has a render-blocking `@import` (mitigated by `display=swap`).

### Image Optimization
No images are used in the application. The OG image `og-image.png` (referenced in all HTML pages) is not in the audited file set — existence unconfirmed.

### Lazy Loading
No lazy loading for the deals table — all deals are loaded in one fetch. `renderDesktopTable` does use a "Load More" pattern (PAGE_SIZE = 50) but the full 7MB JSON is still fetched upfront.

### Caching
- `GITHUB_DB + '?t=' + Date.now()` (app.js line 305): cache-busts on every page load, defeating browser cache and CDN edge cache. This means every user makes a fresh 7MB fetch every time they visit.
- Service worker: caches static assets (FIX-sw.js lines 4–15). Does not cache deals.json (network-only for github.com, line 47).
- Vercel headers do not set explicit `Cache-Control` for `deals.json` — GitHub's raw CDN serves it with short TTLs. The cache-buster makes CDN caching irrelevant.

### API Response Size
deals.json at ~7MB is the primary performance problem. The `JSON.stringify(deduped, null, 2)` with 2-space indentation (FIX-export-to-github.js line 166) adds approximately 15–20% size versus `JSON.stringify(deduped)`. With 13,000+ records, removing indentation saves ~1MB.

### Client-Side Rendering Cost
`buildRowInner()` (app.js lines 726–748) constructs HTML via string concatenation for each row. For 50 rows this is fast. But when `isFiltered = true`, all matched records render synchronously. For a search term like "e" that matches 5,000+ records, this blocks the main thread.

**Fix:** Add a cap to filtered renders: `var toRender = filteredDeals.slice(0, Math.min(filteredDeals.length, 500))` with a note showing "+ N more". Or implement virtual scrolling.

### Chart
`renderVolumeChart` is referenced (app.js line 347) but the implementation is in `charts.js` which was not in the audited file set. DEPLOY-index.html line 887 loads `charts.js` with no `defer` or `async`, meaning it is render-blocking.

### Cron/Queue Efficiency
FIX-scheduler-v2.js: 
- SEC runs every 30 minutes with `lookback_days=2` — fetches same filings multiple times unless dedup check works
- Export runs every 2 hours (line 190) — correct cadence for a 7MB file
- Stats cache invalidation (line 202) deletes the cache entry but does not pre-warm it — the first API call after invalidation will be slow

---

## SEO Audit

### Page Titles
- Homepage: "mergers.news — Global M&A Deal Intelligence | Search 10,000+ Deals" (68 chars) — slightly long but acceptable
- IPO: "IPO Watch 2025-2026 — Pre-IPO Companies & Upcoming IPOs | mergers.news" (71 chars) — references 2025-2026 when the current year is 2026
- Tender Offers: "SEC Tender Offer Database — SC TO-T Filings 1993 to Present | mergers.news" (75 chars) — at the limit
- All other pages have appropriate titles

### Meta Descriptions
All pages have meta descriptions. The homepage description (DEPLOY-index.html line 7) is 174 characters — within Google's ~155 character display limit for the important part. Strong keyword targeting.

### Canonical URLs
All pages have `<link rel="canonical">`. Canonical URLs match the Vercel rewrite destinations. No canonical issues.

### Slugs
Deal permalink pattern is `/deal/{uuid}` (app.js line 847). UUIDs are not human-readable or keyword-rich. Ideally slugs would be `/deal/microsoft-activision-2023-{short-id}` for SEO, but this requires slug generation in the export pipeline. Current UUIDs are acceptable given the SPA redirect pattern makes these pages uncrawlable anyway.

### Open Graph
All pages have `og:type`, `og:title`, `og:description`, `og:url`, `og:image`, `og:site_name`. The `og:image` points to `https://mergers.news/og-image.png` — this file's existence is unconfirmed (not in audited files). If missing, social previews show no image.

### Twitter Cards
All pages have `twitter:card: "summary_large_image"`, `twitter:title`, `twitter:image`. Missing `twitter:description` on all pages — add it.

### Article Schema
No `Article` or `NewsArticle` schema on any page. For deal detail pages (which exist at `/deal/{id}` as modal-only, not separate crawlable pages), schema is moot. The homepage has `Dataset` schema (DEPLOY-index.html lines 33) — appropriate.

### Sitemap
DEPLOY-sitemap.xml covers 11 URLs. The sitemap `lastmod` dates are all `2026-06-08` — static. These should be dynamically updated when content changes. Missing: `/monitoring`, `/legal/*` pages.

### Robots.txt
Missing entirely — see Fix 8.

### Internal Linking
Strong internal linking from every page to major sections. The "Learn" cards (DEPLOY-index.html lines 613–634) have no links, which is a missed opportunity for internal linking to sector pages or filing type pages.

### Indexability
Deal permalink URLs (`/deal/{uuid}`) are not indexable: the 404 page redirects to `/` and JavaScript opens a modal. Search engines cannot see deal content. This is acceptable if the homepage/sector pages carry the SEO value, but individual deal pages have zero SEO benefit. Consider adding a server-side rendered deal detail page for the top 1000 deals by value.

### Duplicate Content Risk
The technology, healthcare, and financial-services sector pages (DEPLOY-mergers-technology.html, DEPLOY-mergers-healthcare.html, DEPLOY-mergers-financial-services.html) were not fully read but their structure loads the same deals.json and filters client-side. Since they load the same data and render similar content, there is potential for thin-content penalty unless each sector page has substantial unique introductory copy, which the tender-offers and about pages demonstrate is the pattern.

---

## Security Audit

### External URL Handling
`safeUrl()` (app.js lines 42–47) correctly validates URLs against `^https?://` or `^/`. The `esc()` function blocks `javascript:`, `data:`, `vbscript:` in URLs (line 39). SEC EDGAR URLs passed through `safeUrl` are rendered as `target="_blank" rel="noopener"` links (app.js lines 744, 955). The `rel="noopener"` prevents the opened page from accessing `window.opener`. Correct.

### HTML Sanitization
The main app.js correctly calls `esc()` on all user-visible data. The critical exception is the IPO page (Fix 1 above).

The `d.body` field in `populateModal` is rendered via `esc(para.trim())` — safe. However, `FIX-export-to-github.js` generates `body` field content via `buildBody()` (lines 270–295) using string templates with `acquirer`, `target`, `dealType` variables that have already been cleaned via `cleanCompanyName()` (lines 337–345). The `cleanCompanyName` function strips ticker symbols and CIK annotations but does NOT HTML-escape the result. If a company name in the DB contains `<` or `>` characters (possible from unvalidated EDGAR data), the `body` field in deals.json could contain unescaped HTML which would then be passed to `esc()` in the frontend — safe because `esc()` handles it.

### XSS Risk
1. **IPO page innerHTML injection** — critical (Fix 1)
2. **Cmd palette recent searches**: `renderRecentSearches()` (app.js line 251) calls `esc(r)` — safe
3. **Comparable items onclick**: app.js line 991 includes `esc(c.id)` in an inline onclick handler: `onclick="openModal(allDeals.find(function(x){return x.id==='` + esc(c.id) + `';}))"`. The ID is a UUID from EDGAR — low injection risk, but using a data attribute + delegated event handler would be cleaner and safer

### SSRF Risk in Ingestion
FIX-eu-ingestor.js line 96 constructs a URL using `caseId` extracted from `c.caseNumber` after sanitizing with `/[^A-Z0-9._-]/gi` (line 94). The resulting URL (`https://ec.europa.eu/competition/elojade/isef/case_details.cfm?proc_code=2_M_{caseId}`) always points to the EC domain — no SSRF risk here.

FIX-news-ingestor.js `fetchText()` (line 373) follows redirects (up to depth 5). A malicious RSS feed could provide a redirect chain to an internal network URL (e.g. `http://169.254.169.254/latest/meta-data/` on AWS). The `fetchText` function does not block private IP ranges. This is SSRF risk on the ingestion server.

**Fix:** In all `fetchText` implementations across ingestors, add a check before following redirects: reject redirect targets that resolve to RFC 1918 addresses, link-local addresses, or loopback.

### Unsafe Redirects
DEPLOY-404.html (line 15): `window.location.replace('/')` — safe, hardcoded to homepage.

### Secrets Exposure
`GITHUB_TOKEN`, `DATABASE_URL` are referenced as `process.env.*` — no hardcoded secrets found in any file. The pie dashboard (DEPLOY-pie-dashboard.html lines 147–155) has a client-side password check. The password is not visible in the audited files — it must be hardcoded in the script block not yet read, or compared against an environment-injected value. Client-side password checks are security theater — anyone can read the source.

### Admin Access
The PIE dashboard at `/monitoring` is "protected" by a client-side password gate. The dashboard reads `pie-health.json` from `/_vercel/...` or a relative URL. If `pie-health.json` is served publicly (which it is — it's a static file), the password gate is irrelevant: the data is accessible without any authentication.

### Rate Limits
FIX-api-service.js (lines 64–72) sets 100 requests per 15 minutes per IP via `express-rate-limit`. The frontend does not use the API — it fetches deals.json directly from GitHub. The rate limiter only protects the Railway-hosted API, not the static frontend data.

### Stored Malicious Content from Feeds
The news RSS ingestor sets `needs_review: true` on all records (line 215). However, review does not block export — `FIX-export-to-github.js` exports all deals regardless of `needs_review` status. A malicious news item that passes the keyword filter would appear in deals.json and be rendered to all users. The `esc()` function prevents XSS execution, but a misleading headline (e.g. false M&A announcement) would still display.

---

## Observability Audit

### Logs
All ingestors emit structured `console.log` with `[TAG]` prefixes (e.g. `[SEC]`, `[NEWS]`, `[EU]`, `[APAC]`). Log format is consistent. Railway captures stdout/stderr logs. No log aggregation service (Datadog, Logtail, etc.) is configured in any file.

### Alerts
MONITOR-pie.js implements a database-backed alert system (tables `pie_alerts`, `pie_checks`) with `upsertAlert` / `resolveAlert` functions. Alerts fire on `fail` or `error` status checks. However:
1. No external notification channel: alerts are stored in the database but never sent to Slack, PagerDuty, email, or any webhook. To see alerts, someone must open the pie dashboard.
2. Three checks that should alert (name_quality, dedup_health, confidence_distribution) are currently erroring (pie-health.json confirms), meaning no alerts fire for data quality degradation.

### Error Reporting
No Sentry, Rollbar, or equivalent error reporting in any file. Frontend JavaScript errors (e.g. from `renderDeals()` throwing) are silently swallowed.

### Ingestion Health Checks
`ingestion_log` table is populated by all 4 ingestors via `startLog` / `endLog`. The `checkIngestionFreshness` and `checkIngestionVelocity` checks use this data — well designed. However, per-source failure tracking requires querying `ingestion_log` with source filter, which is done in `checkSourceDiversity` (MONITOR-pie.js line 188).

### Source-Level Failure Tracking
MONITOR-pie.js `checkSourceDiversity` (lines 188–202) counts active source types in the last 48h. If the EU ingestor fails for 48h, this check goes `warn`. If it fails for >48h, it goes `fail`. The threshold is 2 active sources — if only SEC is working, it's a `warn`. This is reasonable.

### Retry Strategy
No retry logic in any ingestor. Failed fetches log the error and increment `stats.failed`. The job runs again on the next cron tick. For a 30-minute SEC job, a transient failure self-heals within 30 minutes. For the 12-hour EU job, a failure means a 12-hour gap.

### Admin Visibility
The PIE dashboard at `/monitoring` (DEPLOY-pie-dashboard.html) shows: overall score, category scores, individual check results, active alerts, last update time. The data comes from `pie-health.json` (a static file) not from a live API call to the database. This means the dashboard always shows the last written snapshot, not real-time status.

MONITOR-synthetic.js runs product integrity checks (TLS expiry, route availability, deals.json validity, security headers, 404 correctness, adversary fuzzing, path traversal, method abuse, latency) — well-designed. But there is no indication these run on a cron — only if called externally.

---

## Test Plan

### Unit Tests

**File:** `test/unit/esc.test.js`  
```
assert esc(null) === ''
assert esc('<script>') === '&lt;script&gt;'
assert esc('javascript:alert(1)') === '#'
assert esc('https://example.com') === 'https://example.com'
assert esc('normal text') === 'normal text'
```
**Guards against:** XSS via data fields

**File:** `test/unit/safeUrl.test.js`  
```
assert safeUrl('https://sec.gov/...') === 'https://sec.gov/...'
assert safeUrl('javascript:alert(1)') === '#'
assert safeUrl(null) === '#'
assert safeUrl('data:text/html,...') === '#'
assert safeUrl('/relative') === '/relative'
```

**File:** `test/unit/parseDealValue.test.js`  
```
assert parseDealValue('$74B') === 74000000000
assert parseDealValue('$2.5M') === 2500000
assert parseDealValue(null) === 0
assert parseDealValue('Undisclosed') === 0
assert parseDealValue('1.2T') === 0  // T not currently handled
```

**File:** `test/unit/extractOtherParty.test.js` (FIX-sec-ingestor-index.js)  
```
assert extractOtherParty('Agreement and Plan of Merger with and into XYZ Corp', 'DEFM14A') === 'XYZ Corp'
assert extractOtherParty('Offer to Purchase All Outstanding Shares of ABC Inc', 'SC TO-T') === 'ABC Inc'
assert extractOtherParty('', 'DEFM14A') === null
assert extractOtherParty('short', 'DEFM14A') === null
```
**Guards against:** Regression in party name extraction

**File:** `test/unit/extractDealValueCents.test.js`  
```
assert extractDealValueCents('aggregate consideration of $2.5 billion') === 250000000000
assert extractDealValueCents('aggregate consideration of $450 million') === 45000000000
assert extractDealValueCents('') === null
assert extractDealValueCents('termination fee of $150 million. Transaction value of $2.5 billion') === 250000000000  // should take max which is deal value
```

**File:** `test/unit/normalizeName.test.js`  
```
assert normalizeName('ABC Corp.') === 'abc'
assert normalizeName('XYZ Inc.') === 'xyz'
assert normalizeName('Foo & Bar LLC') === 'foo  bar'  // note: &, LLC stripped
// Verify cross-ingestor consistency
assert normalizeName_sec('Foo AG') === normalizeName_news('Foo AG')  // catches the SA/AG discrepancy
```

**File:** `test/unit/isMaDeal.test.js`  
```
assert isMaDeal({title:'Company A agrees to acquire Company B for $2B', description:''}) === true
assert isMaDeal({title:'Company A reports Q3 earnings', description:''}) === false
assert isMaDeal({title:'Company A acquires minority stake in Company B', description:''}) === false
assert isMaDeal({title:'Company A to acquire Company B', description:''}) === true
assert isMaDeal({title:'acquisition', description:''}) === false  // weak kw alone
```
**Guards against:** Non-M&A content reaching the database

### Integration Tests

**File:** `test/integration/sec-ingestor.test.js`  
- Mock EDGAR EFTS API to return a sample hit with realistic `_id`, `_source` structure
- Run `processFiling()` with mocked `fetchJson` / `fetchFilingText`
- Assert: deal inserted with correct `acquirer`, `target`, non-null `filing_date`
- Assert: accession_no in filings table matches `hit._id.split(':')[0]`
- Assert: re-running with same hit returns 'skip' (deduplication works)

**File:** `test/integration/export.test.js`  
- Insert 3 test deals (two with same headline) into test DB
- Run `run()` from FIX-export-to-github.js with `LOCAL_ONLY=true`
- Assert: deals.json written with 2 records (deduplication removed 1)
- Assert: both records have `sourceUrl` field set
- Assert: no `null` values in `id`, `headline` fields

**File:** `test/integration/dedup.test.js`  
- Insert same deal twice via news ingestor and SEC ingestor
- Run deduplication service
- Assert: one record marked as `canonical_id = <other_record_id>`
- Assert: deals.json export contains only 1 record for this deal

### E2E Tests (Playwright)

**File:** `test/e2e/homepage.test.js`  
```
test('loads deals within 5 seconds on desktop') — page.goto('/'); waitForSelector('#dealTable'); assert load < 5000ms
test('search filters deals correctly') — type 'Microsoft' in search; assert result count > 0; all results contain 'microsoft' in headline
test('modal opens and closes') — click first deal row; assert modal visible; press Escape; assert modal hidden
test('Cmd+K opens command palette') — keyboard Ctrl+K; assert cmdOverlay.classList.contains('open')
test('deal permalink preserves on back navigation') — open modal; assert URL = /deal/xxx; navigate back; assert URL = /; assert modal hidden
test('filter pill state updates deal count') — set sector=Technology; assert deal count changes; clear filters; assert deal count returns to total
```

**File:** `test/e2e/ipo.test.js`  
```
test('IPO table loads with all companies') — waitForSelector('#ipoList'); assert row count >= 38
test('filter pills work') — click 's1' pill; assert all rows have S-1 Filed badge
test('modal opens from row click') — click first row; assert ipoModalOverlay visible
test('search filters by company name') — type 'Klarna'; assert only Klarna row visible
```

**File:** `test/e2e/mobile.test.js`  
```
test('mobile bottom nav is visible below 768px') — setViewport(375, 812); assert .bottom-nav visible
test('mobile cards appear instead of table') — assert #dealCardsWrap visible; assert #dealTableWrap hidden
test('mobile search via bottom nav opens command palette') — tap mobileSearchBtn; assert cmdOverlay visible
```

### Visual Regression Tests (Playwright + screenshot)

**Baseline screenshots for:**
- Desktop homepage (1440×900) — hero, KPI cards, table with 50 rows
- Desktop deal modal — open with sample deal
- Mobile homepage (375×812) — bottom nav, mobile cards
- IPO page desktop (1440×900) — full table
- 404 redirect (verify redirect to homepage, not blank page)

**Assertion:** pixel diff < 1% of total pixels versus baseline

### Accessibility Tests (axe-playwright)

**File:** `test/a11y/axe.test.js`  
```
test('homepage has no critical axe violations') — run axe on /; assert violations.critical.length === 0
test('deal modal has no critical axe violations') — open modal; run axe; check for dialog role, focus management
test('IPO page has no critical axe violations')
test('contrast ratios pass WCAG AA') — verify --muted text meets 4.5:1 against --bg
```

### Ingestion Pipeline Tests

**File:** `test/pipeline/sec-full-run.test.js`  
```
test('SEC ingestor with lookback=7 days inserts new deals') — run with LOOKBACK_DAYS=7; assert stats.new > 0
test('SEC ingestor is idempotent') — run twice same day; second run: assert stats.new === 0 (all skipped)
test('DEFM14A correctly identifies target and acquirer') — find a DEFM14A in DB; assert acquirer !== target
test('SC 13E-3 correctly identifies target and acquirer as different entities') — after Fix 6
```

**File:** `test/pipeline/news-feed.test.js`  
```
test('earnings announcement is excluded') — feed item with 'Q3 results'; assert isMaDeal() === false
test('acquisition announcement is included') — feed item with 'agrees to acquire'; assert true
test('minority stake is excluded') — 'acquires minority stake'; assert false
test('deal value extracted from description') — '$2.5 billion deal'; assert extractDealValue() === 250000000000
```

### Synthetic Monitoring Tests
MONITOR-synthetic.js tests run live against production. Add to CI:

```
test('deals.json > 1MB') — assert bytes > 1_000_000
test('all routes return 200') — loop ROUTES array; all < 3000ms
test('TLS valid for > 30 days') — assert daysLeft > 30
test('404 returns 404, not 200') — assert /nonexistent returns 404
test('no path traversal leaks') — assert /.env returns 404
```

### Broken-Link Tests
```
# Run weekly via GitHub Actions
npx linkinator https://mergers.news --recurse --skip deal/ --timeout 10000
```
Assert all internal links return 200.

### Source-Failure Simulation Tests
```
test('EU ingestor gracefully handles EC portal 503') — mock fetchJson to throw; run EU ingestor; assert stats.failed > 0; assert no crash
test('EDGAR EFTS 429 causes retry, not crash') — mock to return 429 twice then 200; assert run completes
test('deals.json GitHub push failure does not corrupt DB') — mock pushToGitHub to throw; run export; assert deals table unchanged
```

### Duplicate-Story Tests
```
test('same deal from SEC + news produces single export record') — insert deal from both sources; run dedup + export; assert deals.json contains one record
test('amended filing SC TO-T/A does not create duplicate deal') — insert SC TO-T then SC TO-T/A for same accession prefix; assert one deal record
```

### Bad-Data Tests
```
test('deal with null headline renders safely') — insert deal with headline=null; run export; assert deals.json row has headline !== null (generated from acquirer/target)
test('deal with XSS in headline is escaped') — insert '<script>alert(1)</script>' as headline; assert esc() in frontend blocks execution
test('deal value of "Trillion" unit handled') — insert dealValue='$1.2T'; assert parseDealValue() does not return NaN
test('extremely long headline (500 chars) does not break table layout') — need CSS max-width fix first
```

---

## Implementation Roadmap

### Phase 1: Critical Bugs and Data-Quality Guards (Week 1–2)

**Task 1.1: Fix IPO Page XSS**  
File: DEPLOY-ipo.html (inline script block), FIX-ipo-dynamic-loader.js  
Action: Add `function esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }` at the top of both scripts. Replace all `c.name`, `c.sector`, `c.notes`, `c.statusLabel`, `c.exchange`, `c.expected`, `c.valuation` occurrences with `esc(c.name)` etc. in renderIPOTable and openIPOModal.  
Acceptance: No unescaped HTML renders from `ipos.json` data.

**Task 1.2: Fix PIE Monitoring Schema Errors**  
File: MONITOR-pie.js  
Action: Fix `checkDedupHealth` join query (lines 303–315): ensure aliases match column names in the actual schema. Fix `checkConfidenceDistribution` column reference (line 424): change to match actual column name. Add automated test that runs all 13 checks and asserts no `isError = true` results.  
Acceptance: pie-health.json shows 0 `status:"skip"` or `status:"error"` entries.

**Task 1.3: Fix EDGAR EFTS Field Mapping**  
File: FIX-sec-ingestor-index.js  
Action: Lines 78–87: change `accession_no: hit._source?.period_of_report` to `accession_no: hit._id.split(':')[0]`. Change `filing_date: hit._source?.period_of_report || hit._source?.file_date` to `filing_date: hit._source?.file_date`.  
Acceptance: Newly ingested filings have valid EDGAR URLs in the export.

**Task 1.4: Fix SC 13E-3 Acquirer/Target Role**  
File: FIX-sec-ingestor-index.js  
Action: Lines 362–366: change to `target = companyName; acquirer = extractOtherParty(docText, 'SC 13E-3') || 'Acquirer (see filing)'`. Add SC 13E-3 patterns to `extractOtherParty`.  
Acceptance: SC 13E-3 records have `acquirer !== target`.

**Task 1.5: Fix Deal Permalink SessionStorage**  
File: app.js  
Action: In `handleUrlParams()` (line 1127), add: `if (!window._pendingDealId) { try { var sid = sessionStorage.getItem('pendingDealId'); if (sid) { window._pendingDealId = sid; sessionStorage.removeItem('pendingDealId'); } } catch(e) {} }`.  
Acceptance: Visiting `/deal/{uuid}` directly opens the correct modal after redirect.

**Task 1.6: Add robots.txt**  
Action: Create `/robots.txt` with `Sitemap:` directive. Add Vercel static route.  
Acceptance: `curl https://mergers.news/robots.txt` returns 200 with `Sitemap:` line.

**Task 1.7: Fix exportBtn Scroll Flash**  
File: DEPLOY-index.html line 317  
Action: Change `<a href="#" class="section-link" id="exportBtn">` to `<button class="section-link" id="exportBtn" type="button">`.  
Acceptance: Clicking Export CSV does not scroll to top.

**Task 1.8: Remove UK Companies House Non-Deal Scraping**  
File: FIX-eu-ingestor.js  
Action: Remove `await runUkCompaniesHouse(stats)` call from `run()` (line 23). Delete the function (lines 156–207).  
Acceptance: EU ingestor run completes without Companies House API calls in logs.

---

### Phase 2: UX/UI Polish and Accessibility (Week 3–4)

**Task 2.1: Unify Header Across All Pages**  
Files: DEPLOY-ipo.html, DEPLOY-about.html, DEPLOY-tender-offers.html, DEPLOY-mergers-technology.html, DEPLOY-mergers-healthcare.html, DEPLOY-mergers-financial-services.html, DEPLOY-contact.html  
Action: Add the `<button class="search-trigger" id="searchTrigger">` and load `app.js` on all subpages. Add `header-nav-btn` class definition to style.css. Move bottom-nav `<style>` to style.css.  
Acceptance: Cmd+K works on all pages; nav hover/active states consistent.

**Task 2.2: Fix Filter Pill State Machine**  
File: app.js, DEPLOY-index.html  
Action: Remove the two-level pill/dropdown system. Replace with single-level pills per filter group that update `state` and call `applyFilters()` on click. Update pill labels to show active filter value.  
Acceptance: Selected filter is visually indicated on the pill; no "Apply" button needed.

**Task 2.3: Fix Modal Focus Trap**  
File: app.js, DEPLOY-index.html  
Action: In `openModal()`, after `overlay.focus()`, add focus trap: intercept Tab/Shift+Tab keydown and cycle focus among focusable elements within `#modal`. On `closeModal()`, return focus to the row that opened the modal.  
Acceptance: Tab navigation does not escape the modal.

**Task 2.4: Fix Industry Card Inconsistency**  
File: DEPLOY-index.html lines 492–513  
Action: Change Energy, Consumer, Telecom, Media industry cards from `<a href="#" onclick="filterBySector(...)">` to actual page links (create sector pages or link to `/?sector=Energy`).  
Acceptance: All industry cards are anchor links; keyboard Enter navigates correctly.

**Task 2.5: Fix Overlong Headline Overflow**  
File: style.css  
Action: Add to `.deal-headline-cell .headline`: `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px;`  
Acceptance: 500-character headlines do not break table layout.

**Task 2.6: Add Loading State to IPO Page**  
File: DEPLOY-ipo.html  
Action: Show skeleton rows in `#ipoList` until `init()` calls `renderIPOTable`. Use the same skeleton pattern as the deal table.  
Acceptance: IPO page shows loading state, not empty table, on first render.

**Task 2.7: Fix `<tbody role="list">` ARIA Error**  
File: DEPLOY-index.html line 438  
Action: Remove `role="list"` and `aria-label="M&A deals"` from `<tbody>`.  
Acceptance: No axe ARIA role violations on deal table.

**Task 2.8: Add `twitter:description` to All Pages**  
Files: All DEPLOY-*.html  
Action: Add `<meta name="twitter:description" content="...">` to each page's `<head>`.  
Acceptance: Twitter card previews show description text.

---

### Phase 3: Performance and SEO (Week 5–6)

**Task 3.1: Remove Cache-Buster from deals.json URL**  
File: app.js line 305  
Action: Change `GITHUB_DB + '?t=' + Date.now()` to `GITHUB_DB + '?v=' + currentVersionDate` where `currentVersionDate` is a constant updated in the export script each run (store last-updated date in a separate `deals-version.json`).  
Acceptance: Browser cache is used for repeat visits; only new deploys break cache.

**Task 3.2: Split deals.json into Recent + Full**  
File: FIX-export-to-github.js  
Action: Write two files: `deals-recent.json` (records with `announcement_date >= NOW() - INTERVAL '2 years'`, approximately 500–1000 records, ~300KB) and `deals-full.json` (all records). App.js loads `deals-recent.json` first, enables UI immediately, then lazy-loads `deals-full.json` in the background when user scrolls to bottom or uses date filters.  
Acceptance: Initial load is <300KB; full dataset available on demand.

**Task 3.3: Add Filtered Render Cap**  
File: app.js  
Action: In `renderDesktopTable` and `renderMobileCards`, cap `isFiltered` renders at 500 records: `var toRender = isFiltered ? filteredDeals.slice(0, 500) : filteredDeals.slice(0, PAGE_SIZE)`. Add "Showing first 500 of N results" message when cap is hit.  
Acceptance: Filtering 'e' (matching 5,000 records) does not freeze the UI.

**Task 3.4: Minify deals.json Output**  
File: FIX-export-to-github.js line 166  
Action: Change `JSON.stringify(deduped, null, 2)` to `JSON.stringify(deduped)`.  
Acceptance: deals.json file size reduced by ~15–20%.

**Task 3.5: Move charts.js to Defer**  
File: DEPLOY-index.html line 887  
Action: Change `<script src="/charts.js"></script>` to `<script defer src="/charts.js"></script>`.  
Acceptance: charts.js no longer blocks page render.

**Task 3.6: Update Sitemap lastmod Dynamically**  
File: FIX-export-to-github.js (add sitemap generation), DEPLOY-sitemap.xml  
Action: After exporting deals.json, regenerate sitemap.xml with the current date as `lastmod`. Push sitemap.xml to GitHub alongside deals.json.  
Acceptance: Sitemap `lastmod` dates reflect actual content update dates.

**Task 3.7: Fix GitHub API Authorization Header**  
File: FIX-export-to-github.js line 449  
Action: Change `'Authorization': \`token ${GITHUB_TOKEN}\`` to `'Authorization': \`Bearer ${GITHUB_TOKEN}\``.  
Acceptance: GitHub API calls succeed with modern auth format.

---

### Phase 4: Observability and Automated Reporting (Week 7–8)

**Task 4.1: Add External Alert Notification Channel**  
File: MONITOR-pie.js  
Action: In `processAlerts()`, after `upsertAlert()`, send a webhook to a Slack channel or email via Resend/SendGrid when a check transitions from pass→fail. Add `ALERT_WEBHOOK_URL` env var. Only fire on state transitions, not on every check run.  
Acceptance: A `fail` check result sends a Slack message within 5 minutes.

**Task 4.2: Fix PIE Dashboard to Use Live Data**  
File: DEPLOY-pie-dashboard.html  
Action: Replace `pie-health.json` read with a live API call to `/api/health/pie` which returns current check results from the database. Add `/api/health/pie` route to FIX-api-service.js that queries `pie_checks` and `pie_alerts`.  
Acceptance: Dashboard refreshes with real-time data; no stale static file.

**Task 4.3: Add Scheduler Health Check HTTP Endpoint**  
File: FIX-scheduler-v2.js  
Action: Add a minimal HTTP server on port `process.env.PORT || 3001`: `GET /health` returns `{ status: 'ok', uptime: process.uptime(), lastRuns: { sec: ..., news: ..., eu: ..., apac: ... } }`. Store last-run timestamps in memory.  
Acceptance: Railway health probe successfully hits `/health`; process restarts if health probe fails.

**Task 4.4: Add Frontend Error Reporting**  
File: app.js, all HTML files  
Action: Add a global error handler in app.js: `window.addEventListener('error', function(e) { /* send to /api/errors or external service */ })`. Alternatively, add Sentry CDN snippet with `dsn` from environment.  
Acceptance: JavaScript errors in production appear in error dashboard within 1 minute.

**Task 4.5: Add Ingestion Rate Limit Handling**  
File: FIX-sec-ingestor-index.js  
Action: Add `sleep(150)` between EDGAR EFTS requests. Add retry with exponential backoff (up to 3 retries) for 429 and 503 responses in `fetchJson`.  
Acceptance: SEC ingestor does not fail due to rate limiting; retries 429s automatically.

**Task 4.6: Deduplicate normalizeName Implementations**  
Files: FIX-news-ingestor.js, FIX-eu-ingestor.js, FIX-apac-ingestor.js, FIX-enrich-deals.js, FIX-sec-ingestor-index.js  
Action: Create `services/shared/db-utils.js` exporting `normalizeName`, `upsertCompany`, `insertDeal`, `startLog`, `endLog`. Update all 4 ingestors to `require('../shared/db-utils')`.  
Acceptance: Single `normalizeName` implementation with SA/AG/NV/BV/SE suffixes; all ingestors normalize identically.

---

### Phase 5: Advanced Ingestion Reliability (Week 9–12)

**Task 5.1: Implement SSRF Protection in Fetchers**  
Files: FIX-news-ingestor.js, FIX-eu-ingestor.js, FIX-apac-ingestor.js, FIX-sec-ingestor-index.js  
Action: Before following redirects in `fetchText`, resolve the target hostname and check against RFC 1918 blocklist: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`, `169.254.169.254`. Reject if private.  
Acceptance: Redirect to `http://169.254.169.254` returns error, not data.

**Task 5.2: Fix ASX Ingestor Endpoint**  
File: FIX-apac-ingestor.js  
Action: Replace `announcements.asx.com.au/asxannouncements.asx` with current ASX announcements API. Test against live ASX data.  
Acceptance: ASX ingestor inserts at least 1 M&A record per week.

**Task 5.3: Fix SGX Ingestor for SPA**  
File: FIX-apac-ingestor.js  
Action: Replace `www.sgx.com/securities/company-announcements` HTML scrape with SGX's JSON API endpoint. SGX provides announcement data at `https://api2.sgx.com/sites/default/files/non-listed-company-announcements/...` (verify current URL).  
Acceptance: SGX ingestor inserts at least 1 M&A record per month.

**Task 5.4: Implement CSP Nonces**  
Files: DEPLOY-vercel.json, all DEPLOY-*.html  
Action: Add Vercel Edge Middleware to generate a per-request nonce. Inject the nonce into inline `<script>` tags. Update CSP to replace `'unsafe-inline'` with `'nonce-{NONCE}'`. Move bottom-nav `<style>` blocks to style.css to eliminate `'unsafe-inline'` from `style-src`.  
Acceptance: CSP header contains `'nonce-...'` not `'unsafe-inline'`; all inline scripts have matching nonce.

**Task 5.5: Add Deal-Level Deduplication by Entity+Date in Export**  
File: FIX-export-to-github.js  
Action: In the PostgreSQL query, add deduplication at the SQL level: group by `(acquirer_id, target_id, EXTRACT(YEAR FROM announcement_date))` and keep the row with highest `source_confidence`. This eliminates same-deal duplicates from different sources before export.  
Acceptance: deals.json contains no two records with the same acquirer+target+year triplet (except for sequential multi-step transactions like SC TO-T followed by merger completion).

**Task 5.6: Build Incremental Export**  
File: FIX-export-to-github.js  
Action: Instead of re-exporting all records every 2 hours, maintain a `deals-checksum.json` containing the MD5 of the last exported deals.json. On each export run, check if the data has changed. Only push to GitHub if the checksum differs.  
Acceptance: Export jobs where no new deals were ingested take <1 second and make no GitHub API call.

---

*End of FULL-AUDIT.md — Total findings: 10 high-impact fixes, 7 UI issues, 12 UX issues, 8 ingestion bugs, 6 data contract gaps, 8 code quality issues, 6 performance issues, 8 SEO gaps, 5 security issues, 4 observability gaps, 40+ test cases, 5-phase 12-week roadmap.*
