# mawire-monitor — AGENTS.md

## Overview

This repository is the **Platform Integrity Engine (PIE)** — an externally independent auditing system for [mergers.news](https://mergers.news). It runs on a schedule, executes 13 health checks against the Mergers.news data pipeline, and publishes results as `pie-health.json` for the monitoring dashboard at `mergers.news/monitoring`.

This repo is intentionally isolated from `mawire-db` and `mawire-platform`. It audits those systems from the outside using only read/write access to the shared PostgreSQL database.

## Repository structure

```
index.js                         — all 13 checks, scoring, alert management, export
package.json                     — single dependency: pg
.github/workflows/run.yml        — hourly schedule (every :45), workflow_dispatch
```

## Environment variables

| Variable       | Required | Description                                                          |
|----------------|----------|----------------------------------------------------------------------|
| `DATABASE_URL` | Yes      | PostgreSQL connection string                                         |
| `MAWIRE_TOKEN` | Yes      | GitHub token with write access to `mawire-monitor` and `mawire-site` |

Set both as GitHub Actions secrets: Settings → Secrets and variables → Actions.

## Running locally

```bash
npm ci
DATABASE_URL=<db-url> MAWIRE_TOKEN=<token> node index.js
```

## Health checks — 13 checks across 4 categories

| Category      | Weight | Checks                                                          |
|---------------|--------|-----------------------------------------------------------------|
| **ingestion** | 35%    | freshness, velocity, source diversity, filing coverage          |
| **quality**   | 30%    | name quality, value completeness, data completeness             |
| **pipeline**  | 20%    | dedup health, export freshness, review queue                    |
| **coverage**  | 15%    | geographic coverage, sector coverage, confidence distribution   |

Score ≥ 85 → **healthy** · ≥ 60 → **degraded** · < 60 → **critical**

## Output per run

1. Runs all 13 checks against PostgreSQL
2. Persists results → `pie_checks`, `pie_alerts`, `pie_metrics`, `pie_health_snapshots` tables
3. Upserts/resolves alerts in `pie_alerts`
4. Triggers auto-remediation (e.g. queues placeholder-name deals for re-enrichment)
5. Exports `pie-health.json` to:
   - `realfrantheman/mawire-monitor` (this repo — source of truth)
   - `realfrantheman/mawire-site` (same-origin serving at `mergers.news/pie-health.json`)

## Common tasks

### Add a health check

```js
// In index.js, add a new async function:
async function checkMyNewCheck() {
  const res = await q(`SELECT ...`);
  let status = 'pass', score = 100;
  // evaluate thresholds...
  return check('my_new_check', 'ingestion', status, score, 'message', { detail });
}

// Add to the checkFns array in run():
const checkFns = [
  ...
  checkMyNewCheck,
];
```

Categories: `ingestion`, `quality`, `pipeline`, `coverage`

### Modify alert thresholds

Edit the `T` object at the top of `index.js`.

### Disable a check temporarily

```js
async function checkFoo() {
  return check('foo', 'quality', 'skip', 100, 'Temporarily disabled', {});
}
```

### Trigger a manual run

GitHub → Actions → Platform Integrity Engine → Run workflow

### View recent results

```sql
SELECT check_name, status, score, message, checked_at
FROM pie_checks
ORDER BY checked_at DESC
LIMIT 50;

SELECT * FROM pie_alerts WHERE resolved_at IS NULL ORDER BY last_seen DESC;
```
