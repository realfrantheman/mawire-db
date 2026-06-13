# Monitoring Review — Platform Integrity Engine (PIE)

**Author:** Claude (architecture review)
**Date:** 2026-06-13
**Scope:** Review the current monitor build and integration; recommend a better, more optimal monitoring system that detects and acts like an end user trying to break mergers.news. No code changes made — this is advisory.

---

## TL;DR

The current PIE is a **white-box, database-only** health checker. It is well-structured and the alerting/scoring/auto-remediation scaffolding is genuinely good. But it has two fundamental problems:

1. **It is blind to its own failures.** The live `pie-health.json` reports `overallScore: 100, status: "healthy"` while **7 of its 13 checks are silently broken** — three throw SQL errors ("column does not exist") and four match zero rows ("No active deals"). Because skipped/errored checks are excluded from the weighted score, a half-broken monitor reports a perfect score. This is the single most dangerous property a monitor can have: **false confidence.**

2. **It tests the database, not the product.** PIE never loads a single page of mergers.news, never fetches `deals.json` over HTTP, never checks that the site renders, never measures latency, never follows a link, never behaves like a user. A user-facing outage (Vercel down, bad deploy, broken JS, expired cert, CDN 404, corrupt `deals.json`) would not move the score at all.

The recommendation is **not** to throw PIE away. It is to (a) fix the schema drift and fail-loud on errors, and (b) add a second, independent **black-box synthetic + adversarial monitor** that hits the real site as an end user. The two together — white-box data integrity + black-box product integrity — are what a real monitoring system looks like.

---

## Part 1 — How the current system is built

### Architecture

```
┌─────────────────┐     hourly (:45)      ┌────────────────────┐
│ mawire-monitor  │ ── GitHub Action ───▶ │  index.js (PIE)    │
│ (independent)   │                       │  13 DB checks      │
└─────────────────┘                       └─────────┬──────────┘
                                                     │ reads
                                          ┌──────────▼──────────┐
                                          │ Neon PostgreSQL     │
                                          │ (deals, filings…)   │
                                          └──────────┬──────────┘
                                                     │ writes pie-health.json
                                   ┌─────────────────┴─────────────────┐
                                   ▼                                   ▼
                          mawire-db/pie-health.json        mawire-site/pie-health.json
                                                                       │ served at
                                                                       ▼
                                                          mergers.news/monitoring
```

- **Trigger:** GitHub Actions cron, `45 * * * *` (hourly), plus `workflow_dispatch`.
- **Engine:** `index.js` — opens a `pg` Pool to Neon, runs 13 checks, scores them, persists to four Postgres tables (`pie_checks`, `pie_alerts`, `pie_metrics`, `pie_health_snapshots`), manages alert lifecycle, runs light auto-remediation, and commits `pie-health.json` to two repos via the GitHub Contents API.
- **Surface:** `mergers.news/monitoring` reads the JSON same-origin (cached `no-store`).

### The 13 checks

| Category (weight) | Checks |
|---|---|
| ingestion (35%) | freshness, velocity, source diversity, filing coverage |
| quality (30%) | name quality, value completeness, data completeness |
| pipeline (20%) | dedup health, export freshness, review queue |
| coverage (15%) | geographic, sector, confidence distribution |

### What's genuinely good

- **Clean separation** — the monitor is its own repo, its own Action, its own token. It can't be taken down by a platform deploy. That was the right call.
- **Idempotent schema bootstrap** — `ensureSchema()` means the monitor provisions its own tables. Good for a zero-touch system.
- **Alert lifecycle** — `pie_alerts` with `first_seen`/`last_seen`/`resolved_at` and a 30-minute debounce is real alert management, not just logging.
- **Weighted, category-based scoring** — the right mental model for a composite health score.
- **History retention with pruning** — 14/30/90-day windows keep the tables bounded.

---

## Part 2 — Findings (what's wrong today)

### 🔴 CRITICAL — The monitor reports 100/100 while half-broken

The current production `pie-health.json` shows:

```
name_quality            → "Check error: column \"acquirer\" does not exist"   (skip, 50)
dedup_health            → "Check error: column a.acquirer does not exist"     (skip, 50)
confidence_distribution → "Check error: column \"confidence\" does not exist" (skip, 50)
value_completeness      → "No active deals"   (skip)
data_completeness       → "No active deals"   (skip)
geographic_coverage     → "No active deals"   (skip)
sector_coverage         → "No active deals"   (skip)
```

**Root cause — schema drift.** The checks were written against an assumed schema that never matched production:

| Monitor expects | Production actually has |
|---|---|
| `deals.acquirer` / `deals.target` (text) | `deals.acquirer_id` / `deals.target_id` (FK to a companies table) |
| `deals.confidence` | `deals.source_confidence` |
| `WHERE status = 'active'` | status values are `'Announced'`, `'Completed'`, etc. — never `'active'` |

So 4 checks silently match **zero rows** (every quality/coverage check filters `status='active'`), and 3 checks **throw** because the column doesn't exist.

**Why the score stays 100:** `computeOverallScore()` does `if (c.status === 'skip') continue;` — errored and empty checks are excluded entirely. Six ingestion/pipeline checks pass at 100, and the average of "only the passing checks" is 100. **The quality (30%) and coverage (15%) categories — 45% of the intended score — are simply absent, and nobody is told.**

This means: the entire quality and coverage half of the platform has been **unmonitored since launch**, and the dashboard has been showing a reassuring green 100 the whole time.

### 🟠 HIGH — `skip` is overloaded and silently safe

`skip` is used for three very different things: "not applicable" (no active deals — legitimately fine), "check crashed" (column missing — definitely not fine), and "couldn't determine" (export proxy). All three are treated identically and excluded from scoring. A crashed check must **degrade** the score (or at minimum raise an alert), never be silently dropped. Right now a check that throws on every run is indistinguishable from a healthy one.

### 🟠 HIGH — No end-user / black-box monitoring at all

Nothing in PIE touches the actual website. There is zero coverage for:

- Does `mergers.news` return 200 and render? (bad Vercel deploy, build failure)
- Does `/ipo`, `/about`, `/monitoring`, `/mergers/technology`, etc. each load?
- Does `deals.json` actually serve over the CDN, is it valid JSON, is it non-empty, is it fresh?
- Does the homepage JS run without console errors, and do deals actually appear in the DOM?
- TLS cert expiry, DNS, redirect correctness, security headers.
- Page latency / Core Web Vitals from a real browser.
- Is the service worker serving stale content after a deploy?

A complete frontend outage would leave PIE at 100/100.

### 🟡 MEDIUM — Other observations

- **Single point of measurement.** Both the DB read and the health export run from one GitHub Action region. No external vantage point; if Neon is reachable from GitHub but not from users' regions, PIE won't notice.
- **`export_freshness` uses a proxy.** It falls back to `MAX(deals.updated_at)`, which measures DB writes, not whether `deals.json` was actually committed/served. It can report "fresh" while the published file is hours stale.
- **No notifications.** Alerts live in Postgres and the JSON. If the score craters at 3am, nothing pages anyone — you have to look at the dashboard.
- **No self-monitoring of the monitor.** If the Action fails to run (cron skipped, token expired, npm install breaks), `pie-health.json` just goes stale and the dashboard keeps showing the last good value. There is no "the monitor itself hasn't reported in N hours" check.
- **Auto-remediation writes to prod from the monitor.** `autoRemediate()` runs `UPDATE deals SET needs_review=true`. A monitor that mutates production data blurs the line between observer and actor; if a check misfires, the remediation amplifies it. (Less relevant now that those checks are erroring, but it's a design smell.)

---

## Part 3 — A better approach: dual-plane monitoring

Think of it as two independent planes that rarely fail together:

```
        ┌──────────────────────── PLANE A: DATA INTEGRITY (white-box) ─────────────────────────┐
        │  Today's PIE, fixed. Reads Postgres. Knows the schema. Fails loud on errors.          │
        │  "Is the data correct, fresh, complete, deduped?"                                      │
        └───────────────────────────────────────────────────────────────────────────────────────┘

        ┌──────────────────────── PLANE B: PRODUCT INTEGRITY (black-box) ──────────────────────┐
        │  NEW. Drives the real site like a user. Headless browser + HTTP probes + adversary.   │
        │  "Can a human actually use mergers.news right now, and can I break it?"                │
        └───────────────────────────────────────────────────────────────────────────────────────┘

                 Both write to one combined health JSON → one dashboard, two scores.
```

### Plane A — fix what exists (small, high-value)

1. **Correct the schema.** Join to the companies table for names (`acquirer_id`→companies), use `source_confidence`, and replace `status='active'` with the real active-deal predicate (e.g. `status IN ('Announced','Pending')` — whatever the product treats as live).
2. **Make `skip` honest.** Split into `not_applicable` (excluded from score, fine) vs `error` (counts as a failing check **and** raises a critical alert). A check that throws should never improve or be neutral to the score.
3. **Add a heartbeat check.** Emit `generatedAt`; the dashboard (and Plane B) should alert if `pie-health.json` is older than ~2 hours — "the monitor stopped monitoring" is itself an incident.
4. **Verify the published artifact, not a proxy.** For `export_freshness`, fetch the real `https://mergers.news/deals.json`, check HTTP 200, valid JSON, row count, and max date — measure the thing users actually receive.

### Plane B — the end-user / adversarial monitor (the new build)

This is the part the user is really asking for: **a system that behaves like an end user and actively tries to break the site.** It runs as a second GitHub Action in `mawire-monitor` (independent of Plane A), entirely on free tooling.

**B1. Synthetic user journeys (Playwright, free, open-source)**
Headless Chromium walks the real site like a person:
- Load `/` → assert HTTP 200, assert the deals list actually renders (real DOM nodes, not just bytes), capture any `console.error`, capture failed network requests.
- Crawl every route in `vercel.json` (`/ipo`, `/about`, `/contact`, `/tender-offers`, `/monitoring`, all `/mergers/*`, `/legal/*`) → each must return 200 and render its key element.
- Click into a deal detail (`/deal/:id`) → assert it resolves and shows data.
- Assert `deals.json` and `ipos.json` load, parse, and are non-empty + fresh.
- Take a screenshot per page; diff against the last run to catch silent visual breakage (blank page, missing CSS).
- **Free:** Playwright is MIT-licensed; runs free on GitHub Actions' 2,000 free minutes/month.

**B2. HTTP/infra probes (Node `https` + free APIs)**
- TLS certificate expiry (warn < 21 days) — pure Node, no dependency.
- Security headers present (`X-Content-Type-Options`, CSP, etc.).
- Correct redirects / `cleanUrls` behavior (e.g. `/monitoring.html` vs `/monitoring`).
- Response latency budget per route (fail if p95 > target).
- **Lighthouse CI** (free, open-source) for Core Web Vitals (LCP/CLS/TBT) and an accessibility score, run against the live URL.

**B3. The adversary — "try to break it" (free, in-house fuzzing)**
A deliberately hostile pass that a normal monitor never does:
- **Fuzz deal IDs:** `/deal/0`, `/deal/-1`, `/deal/999999999`, `/deal/abc`, `/deal/<script>` → assert graceful handling (no 500, no stack trace, no reflected input). This is also a lightweight **reflected-XSS probe**.
- **Malformed query strings & path traversal:** `/?q=<script>`, `/../../etc/passwd`, oversized params → assert sanitized, no error leakage.
- **HTTP method abuse:** `POST`/`PUT`/`DELETE` to static routes → assert correct rejection.
- **Cache/SW poisoning check:** load the page, force a new deploy marker, reload → assert the service worker doesn't serve indefinitely stale content (a real risk given `sw.js` caching).
- **Broken-link sweep:** crawl all internal links and assert none 404 (catches a deleted page or bad rewrite).
- **404 correctness:** request a random nonexistent path → assert it returns the real `404.html`, not a soft-200.

**B4. External uptime from outside GitHub's network (free third-party)**
A single vantage point lies. Add an independent watcher so a GitHub-region issue doesn't blind you:
- **UptimeRobot free tier** (50 monitors, 5-min interval) or **Better Stack / Better Uptime free tier** — ping `mergers.news` and `mergers.news/deals.json` from outside, with email/Slack/Telegram alerts. Zero code, zero cost.
- Optional: **Cloudflare Health Checks** (free tier) if the domain is on Cloudflare.

**B5. Real notifications (free)**
Stop relying on someone looking at the dashboard:
- **Telegram Bot API** (free) or a **Discord/Slack incoming webhook** (free) — post a message only on status transitions (healthy→degraded→critical) and on recovery. One `https.request`, no dependency, no cost.
- GitHub Actions can also open a **GitHub Issue** on failure (free, native) so incidents are tracked and assignable.

### Suggested combined output

One JSON, two independent scores, so a green data plane can never hide a red product plane:

```json
{
  "generatedAt": "…",
  "dataIntegrity":    { "score": 92, "status": "healthy",  "checks": [ … ] },
  "productIntegrity": { "score": 40, "status": "critical", "checks": [ … ],
                        "screenshots": [ … ], "brokenLinks": [ … ] },
  "overall": "critical",          // = worst of the two planes, never the average
  "monitorHeartbeat": "ok"
}
```

**Key scoring rule:** `overall = worst(dataIntegrity, productIntegrity)`, not the average. A monitor's job is to surface the worst thing, not dilute it.

---

## Part 4 — Free tooling summary

| Capability | Tool | Cost | Notes |
|---|---|---|---|
| Synthetic browser journeys | **Playwright** | Free (MIT) | Runs on GH Actions free minutes |
| Performance / a11y / SEO | **Lighthouse CI** | Free (OSS) | Against the live URL |
| Visual regression | Playwright screenshots + pixel diff | Free | Commit baseline to repo |
| External uptime + alerts | **UptimeRobot** or **Better Stack** free tier | Free | Outside-GitHub vantage point |
| TLS / headers / fuzzing | Node `https` (in-house) | Free | No dependencies |
| Notifications | **Telegram bot** / Discord / Slack webhook | Free | Alert on transitions only |
| Incident tracking | **GitHub Issues** (native) | Free | Auto-open on critical |
| Scheduling / compute | **GitHub Actions** | Free | 2,000 min/mo |

Everything above fits the existing "independent, Codex-controlled, zero-infra-cost" model of `mawire-monitor`. No servers, no paid SaaS.

---

## Part 5 — Recommended sequence (when you decide to act)

1. **Fix Plane A schema drift** + make errored checks fail loud. (Highest value, smallest change — restores the 45% of scoring that's currently dark.)
2. **Add the monitor heartbeat** + verify the real published `deals.json`.
3. **Add Plane B synthetic journeys** (Playwright) as a second Action — routes load, deals render, links resolve.
4. **Add the adversary pass** (fuzz IDs, XSS probe, 404 correctness, method abuse).
5. **Wire free notifications** (Telegram/Discord) + **external uptime** (UptimeRobot).
6. **Add Lighthouse CI** for performance/accessibility budgets.
7. **Update the `/monitoring` dashboard** to show both planes side by side, with `overall = worst`.

Each step is independently shippable and independently valuable. Step 1 alone fixes the most dangerous problem: a monitor that says everything is fine when it isn't.

---

*No code was changed as part of this review. This document is advisory only.*
