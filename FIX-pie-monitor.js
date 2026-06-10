'use strict';
/**
 * Platform Integrity Engine (PIE) — autonomous health monitoring for Mergers.news
 *
 * Runs 13 checks across 4 categories: ingestion, quality, pipeline, coverage.
 * Persists results to PostgreSQL, manages alerts, triggers auto-remediation,
 * and exports pie-health.json to GitHub for the /monitoring dashboard.
 *
 * Schedule: every 1 hour (via scheduler)
 */

const { Pool } = require('pg');
const https    = require('https');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const DB_URL      = process.env.DATABASE_URL;
const GH_TOKEN    = process.env.GITHUB_TOKEN || process.env.MAWIRE_TOKEN;
const GH_OWNER    = 'realfrantheman';
const GH_REPO     = 'mawire-db';
const GH_SITE     = 'mawire-site';
const HEALTH_FILE = 'pie-health.json';

const T = {
  freshness_warn_h:      4,
  freshness_fail_h:      8,
  velocity_24h_warn:     3,
  velocity_24h_fail:     0,
  review_warn:          50,
  review_fail:         200,
  name_placeholder_warn: 0.15,
  name_placeholder_fail: 0.30,
  value_missing_warn:    0.55,
  value_missing_fail:    0.80,
  confidence_low_warn:   0.25,
  confidence_low_fail:   0.45,
  export_stale_warn_h:   5,
  export_stale_fail_h:  14,
  source_active_min:     2,
};

const PLACEHOLDERS = [
  'Undisclosed', 'Disclosed in filing', 'Acquirer (see filing)', 'Unknown', 'N/A',
];

const CATEGORY_WEIGHTS = {
  ingestion: 0.35,
  quality:   0.30,
  pipeline:  0.20,
  coverage:  0.15,
};

// ── DATABASE ──────────────────────────────────────────────────────────────────
let _pool;
function db() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return _pool;
}

async function q(sql, params = []) {
  const c = await db().connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

// ── SCHEMA BOOTSTRAP (idempotent) ─────────────────────────────────────────────
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS pie_checks (
      id         SERIAL       PRIMARY KEY,
      check_name VARCHAR(80)  NOT NULL,
      category   VARCHAR(40)  NOT NULL,
      status     VARCHAR(10)  NOT NULL,
      score      NUMERIC(5,2),
      message    TEXT,
      detail     JSONB,
      checked_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pie_alerts (
      id            SERIAL       PRIMARY KEY,
      alert_key     VARCHAR(150) NOT NULL UNIQUE,
      severity      VARCHAR(20)  NOT NULL,
      title         TEXT         NOT NULL,
      description   TEXT,
      check_name    VARCHAR(80),
      first_seen    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      last_seen     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      resolved_at   TIMESTAMPTZ,
      auto_remedied BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS pie_metrics (
      id          SERIAL      PRIMARY KEY,
      metric_name VARCHAR(80) NOT NULL,
      value       NUMERIC,
      unit        VARCHAR(30),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pie_health_snapshots (
      id            SERIAL       PRIMARY KEY,
      overall_score NUMERIC(5,2),
      pass_count    INT DEFAULT 0,
      warn_count    INT DEFAULT 0,
      fail_count    INT DEFAULT 0,
      active_alerts INT DEFAULT 0,
      snapshot      JSONB,
      taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pie_checks_at    ON pie_checks(checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_alerts_open  ON pie_alerts(resolved_at) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pie_metrics_name ON pie_metrics(metric_name, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_snaps_at     ON pie_health_snapshots(taken_at DESC);
  `);
}

// ── CHECK RESULT BUILDER ──────────────────────────────────────────────────────
function check(name, category, status, score, message, detail = {}) {
  return { name, category, status, score: Math.round(score), message, detail };
}

// ── 13 HEALTH CHECKS ─────────────────────────────────────────────────────────

// 1. Ingestion freshness — how recent is the newest deal?
async function checkIngestionFreshness() {
  const res = await q(`
    SELECT
      MAX(created_at) AS last_deal,
      EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS age_h
    FROM deals
  `);
  const row = res.rows[0];
  if (!row.last_deal) {
    return check('ingestion_freshness', 'ingestion', 'fail', 0,
      'No deals found in database', {});
  }
  const ageH = parseFloat(row.age_h);
  let status = 'pass', score = 100;
  if (ageH > T.freshness_fail_h)      { status = 'fail'; score = 10; }
  else if (ageH > T.freshness_warn_h) { status = 'warn'; score = 55; }
  return check('ingestion_freshness', 'ingestion', status, score,
    `Last deal ingested ${ageH.toFixed(1)}h ago`,
    { lastDeal: row.last_deal, ageHours: parseFloat(ageH.toFixed(2)) });
}

// 2. Ingestion velocity — deal count over rolling windows
async function checkIngestionVelocity() {
  const res = await q(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS last_7d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS last_30d
    FROM deals
  `);
  const v24 = parseInt(res.rows[0].last_24h, 10);
  const v7d  = parseInt(res.rows[0].last_7d,  10);
  const v30d = parseInt(res.rows[0].last_30d, 10);
  let status = 'pass', score = 100;
  if (v24 <= T.velocity_24h_fail)      { status = 'fail'; score = 5;  }
  else if (v24 < T.velocity_24h_warn)  { status = 'warn'; score = 50; }
  return check('ingestion_velocity', 'ingestion', status, score,
    `${v24} deals last 24h · ${v7d} last 7d · ${v30d} last 30d`,
    { last24h: v24, last7d: v7d, last30d: v30d });
}

// 3. Source diversity — are multiple data sources contributing?
async function checkSourceDiversity() {
  const res = await q(`
    SELECT ds.source_type, COUNT(DISTINCT d.id) AS cnt
    FROM deal_sources ds
    JOIN deals d ON d.id = ds.deal_id
    WHERE d.created_at > NOW() - INTERVAL '48 hours'
    GROUP BY ds.source_type
    ORDER BY cnt DESC
  `);
  const activeSources = res.rows.length;
  let status = 'pass', score = 100;
  if (activeSources === 0)                       { status = 'fail'; score = 0;  }
  else if (activeSources < T.source_active_min)  { status = 'warn'; score = 50; }
  return check('source_diversity', 'ingestion', status, score,
    `${activeSources} source type(s) active in last 48h`,
    { activeSources, sources: res.rows.map(r => ({ type: r.source_type, count: parseInt(r.cnt, 10) })) });
}

// 4. SEC filing type coverage — are all expected types appearing?
async function checkFilingCoverage() {
  const EXPECTED = ['DEFM14A', 'SC TO-T', 'S-4', 'DEFA14A'];
  const res = await q(`
    SELECT filing_type, COUNT(*) AS cnt
    FROM filings
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY filing_type
  `);
  const seen    = new Set(res.rows.map(r => r.filing_type));
  const missing = EXPECTED.filter(t => !seen.has(t));
  let status = 'pass', score = 100;
  if (missing.length >= 3)      { status = 'fail'; score = 20; }
  else if (missing.length >= 1) { status = 'warn'; score = 70; }
  return check('filing_coverage', 'ingestion', status, score,
    missing.length === 0
      ? `All ${EXPECTED.length} key filing types seen in last 7d`
      : `Missing in last 7d: ${missing.join(', ')}`,
    { expected: EXPECTED, seen: [...seen], missing });
}

// 5. Company name quality — placeholder names in active deals
async function checkNameQuality() {
  const res = await q(`
    SELECT
      COUNT(*)                                                                AS total,
      COUNT(*) FILTER (WHERE acquirer = ANY($1) OR target = ANY($1))        AS with_placeholder,
      COUNT(*) FILTER (WHERE acquirer = ANY($1) AND target = ANY($1))       AS both_placeholder
    FROM deals
    WHERE status = 'active'
  `, [PLACEHOLDERS]);
  const total   = parseInt(res.rows[0].total,            10);
  const bad     = parseInt(res.rows[0].with_placeholder, 10);
  const bothBad = parseInt(res.rows[0].both_placeholder, 10);
  if (total === 0) return check('name_quality', 'quality', 'skip', 100, 'No active deals', {});
  const ratio = bad / total;
  let status = 'pass', score = 100;
  if (ratio > T.name_placeholder_fail)      { status = 'fail'; score = 20; }
  else if (ratio > T.name_placeholder_warn) { status = 'warn'; score = 60; }
  return check('name_quality', 'quality', status, score,
    `${bad}/${total} active deals (${(ratio * 100).toFixed(1)}%) have placeholder names`,
    { total, withPlaceholder: bad, bothPlaceholder: bothBad, ratio: parseFloat(ratio.toFixed(4)) });
}

// 6. Deal value completeness
async function checkValueCompleteness() {
  const res = await q(`
    SELECT
      COUNT(*)                                                      AS total,
      COUNT(*) FILTER (WHERE deal_value IS NULL OR deal_value = 0) AS missing
    FROM deals
    WHERE status = 'active'
  `);
  const total   = parseInt(res.rows[0].total,   10);
  const missing = parseInt(res.rows[0].missing, 10);
  if (total === 0) return check('value_completeness', 'quality', 'skip', 100, 'No active deals', {});
  const ratio = missing / total;
  let status = 'pass', score = 100;
  if (ratio > T.value_missing_fail)      { status = 'fail'; score = 30; }
  else if (ratio > T.value_missing_warn) { status = 'warn'; score = 65; }
  return check('value_completeness', 'quality', status, score,
    `${missing}/${total} active deals (${(ratio * 100).toFixed(1)}%) missing deal value`,
    { total, missing, ratio: parseFloat(ratio.toFixed(4)) });
}

// 7. Overall data completeness — sector, region, country, headline
async function checkDataCompleteness() {
  const res = await q(`
    SELECT
      COUNT(*)                                                                   AS total,
      COUNT(*) FILTER (WHERE sector   IS NOT NULL AND sector   <> '')           AS has_sector,
      COUNT(*) FILTER (WHERE region   IS NOT NULL AND region   <> '')           AS has_region,
      COUNT(*) FILTER (WHERE country  IS NOT NULL AND country  <> '')           AS has_country,
      COUNT(*) FILTER (WHERE headline IS NOT NULL AND LENGTH(headline) > 20)    AS has_headline
    FROM deals
    WHERE status = 'active'
  `);
  const r     = res.rows[0];
  const total = parseInt(r.total, 10);
  if (total === 0) return check('data_completeness', 'quality', 'skip', 100, 'No active deals', {});
  const fields  = ['has_sector', 'has_region', 'has_country', 'has_headline'];
  const scores  = fields.map(f => parseInt(r[f], 10) / total);
  const avgFill = scores.reduce((a, b) => a + b, 0) / fields.length;
  let status = 'pass', score = Math.round(avgFill * 100);
  if (avgFill < 0.60) { status = 'fail'; }
  else if (avgFill < 0.80) { status = 'warn'; }
  return check('data_completeness', 'quality', status, score,
    `${(avgFill * 100).toFixed(1)}% average field completeness across active deals`,
    {
      total,
      sector:   parseFloat((parseInt(r.has_sector,   10) / total).toFixed(3)),
      region:   parseFloat((parseInt(r.has_region,   10) / total).toFixed(3)),
      country:  parseFloat((parseInt(r.has_country,  10) / total).toFixed(3)),
      headline: parseFloat((parseInt(r.has_headline, 10) / total).toFixed(3)),
    });
}

// 8. Dedup health — near-duplicate pairs that escaped deduplication
async function checkDedupHealth() {
  const res = await q(`
    SELECT COUNT(*) AS dup_pairs
    FROM (
      SELECT a.id
      FROM deals a
      JOIN deals b
        ON b.id > a.id
       AND LOWER(a.acquirer) = LOWER(b.acquirer)
       AND LOWER(a.target)   = LOWER(b.target)
       AND a.acquirer <> 'Undisclosed'
       AND a.target   <> 'Undisclosed'
       AND ABS(EXTRACT(EPOCH FROM (a.created_at - b.created_at))) < 21600
      LIMIT 500
    ) pairs
  `);
  const dups = parseInt(res.rows[0].dup_pairs, 10);
  let status = 'pass', score = 100;
  if (dups > 50)      { status = 'fail'; score = 20; }
  else if (dups > 15) { status = 'warn'; score = 60; }
  return check('dedup_health', 'pipeline', status, score,
    `${dups} potential duplicate deal pairs detected`,
    { duplicatePairs: dups });
}

// 9. Export freshness — when were deals last exported?
async function checkExportFreshness() {
  // Try stats_cache first (populated by export script if it writes one)
  const cached = await q(`
    SELECT value::text AS ts
    FROM stats_cache
    WHERE key = 'last_github_export'
    LIMIT 1
  `).catch(() => ({ rows: [] }));

  let ageH;
  let source = 'stats_cache';

  if (cached.rows.length > 0) {
    ageH = (Date.now() - new Date(cached.rows[0].ts).getTime()) / 3_600_000;
  } else {
    // Proxy: most recent deal update_at
    const proxy = await q(`SELECT MAX(updated_at) AS t FROM deals`);
    if (!proxy.rows[0].t) {
      return check('export_freshness', 'pipeline', 'skip', 100,
        'Cannot determine export freshness', { proxy: true });
    }
    ageH = (Date.now() - new Date(proxy.rows[0].t).getTime()) / 3_600_000;
    source = 'deals.updated_at (proxy)';
  }

  let status = 'pass', score = 100;
  if (ageH > T.export_stale_fail_h)      { status = 'fail'; score = 10; }
  else if (ageH > T.export_stale_warn_h) { status = 'warn'; score = 60; }
  return check('export_freshness', 'pipeline', status, score,
    `deals.json last updated ${ageH.toFixed(1)}h ago (via ${source})`,
    { ageHours: parseFloat(ageH.toFixed(2)), source });
}

// 10. Review queue depth — how many deals are pending human review?
async function checkReviewQueue() {
  const res = await q(`
    SELECT
      COUNT(*) FILTER (WHERE needs_review = true)  AS needs_review,
      COUNT(*)                                     AS total
    FROM deals
    WHERE status = 'active'
  `);
  const queueSize = parseInt(res.rows[0].needs_review, 10);
  const total     = parseInt(res.rows[0].total,        10);
  let status = 'pass', score = 100;
  if (queueSize > T.review_fail)      { status = 'fail'; score = 10; }
  else if (queueSize > T.review_warn) { status = 'warn'; score = 55; }
  return check('review_queue', 'pipeline', status, score,
    `${queueSize} of ${total} active deals need review`,
    { queueSize, totalActive: total });
}

// 11. Geographic coverage — are deals spread across regions?
async function checkGeographicCoverage() {
  const res = await q(`
    SELECT
      COUNT(*)                                                            AS total,
      COUNT(*) FILTER (WHERE region IS NOT NULL AND region <> '')        AS with_region,
      COUNT(DISTINCT region) FILTER (WHERE region IS NOT NULL AND region <> '') AS distinct_regions
    FROM deals
    WHERE status = 'active'
  `);
  const r       = res.rows[0];
  const total   = parseInt(r.total,            10);
  const covered = parseInt(r.with_region,      10);
  const regions = parseInt(r.distinct_regions, 10);
  if (total === 0) return check('geographic_coverage', 'coverage', 'skip', 100, 'No active deals', {});
  const coverageRatio = covered / total;
  let status = 'pass', score = Math.min(100, Math.round(coverageRatio * 100 * (regions >= 3 ? 1 : 0.7)));
  if (regions < 2 || coverageRatio < 0.5) { status = 'warn'; score = Math.min(score, 60); }
  const topRes = await q(`
    SELECT region, COUNT(*) AS cnt
    FROM deals
    WHERE status = 'active' AND region IS NOT NULL AND region <> ''
    GROUP BY region ORDER BY cnt DESC LIMIT 8
  `);
  return check('geographic_coverage', 'coverage', status, score,
    `${regions} region(s) · ${covered}/${total} deals have region set`,
    {
      total, withRegion: covered, distinctRegions: regions,
      topRegions: topRes.rows.map(r2 => ({ region: r2.region, count: parseInt(r2.cnt, 10) })),
    });
}

// 12. Sector coverage — are deals distributed across sectors?
async function checkSectorCoverage() {
  const res = await q(`
    SELECT
      COUNT(*)                                                           AS total,
      COUNT(DISTINCT sector) FILTER (WHERE sector IS NOT NULL AND sector <> '') AS distinct_sectors
    FROM deals
    WHERE status = 'active'
  `);
  const total   = parseInt(res.rows[0].total,           10);
  const sectors = parseInt(res.rows[0].distinct_sectors, 10);
  if (total === 0) return check('sector_coverage', 'coverage', 'skip', 100, 'No active deals', {});
  let status = 'pass', score = 100;
  if (sectors < 2) { status = 'warn'; score = 45; }
  const topRes = await q(`
    SELECT sector, COUNT(*) AS cnt
    FROM deals
    WHERE status = 'active' AND sector IS NOT NULL AND sector <> ''
    GROUP BY sector ORDER BY cnt DESC LIMIT 8
  `);
  return check('sector_coverage', 'coverage', status, score,
    `${sectors} sector(s) represented in active deals`,
    { distinctSectors: sectors, topSectors: topRes.rows.map(r => ({ sector: r.sector, count: parseInt(r.cnt, 10) })) });
}

// 13. Confidence score distribution
async function checkConfidenceDistribution() {
  const res = await q(`
    SELECT
      COUNT(*)                                                              AS total,
      COUNT(*) FILTER (WHERE confidence >= 0.85)                          AS high,
      COUNT(*) FILTER (WHERE confidence >= 0.70 AND confidence < 0.85)   AS medium,
      COUNT(*) FILTER (WHERE confidence < 0.70)                           AS low,
      ROUND(AVG(confidence)::numeric, 3)                                  AS avg_conf
    FROM deals
    WHERE status = 'active' AND confidence IS NOT NULL
  `);
  const r     = res.rows[0];
  const total = parseInt(r.total, 10);
  if (total === 0) {
    return check('confidence_distribution', 'coverage', 'skip', 100,
      'No active deals with confidence scores', {});
  }
  const low      = parseInt(r.low, 10);
  const lowRatio = low / total;
  const avg      = parseFloat(r.avg_conf);
  let status = 'pass', score = 100;
  if (lowRatio > T.confidence_low_fail)      { status = 'fail'; score = 30; }
  else if (lowRatio > T.confidence_low_warn) { status = 'warn'; score = 65; }
  return check('confidence_distribution', 'coverage', status, score,
    `Avg confidence ${avg} · ${low}/${total} (${(lowRatio * 100).toFixed(1)}%) below 0.70`,
    {
      total, high: parseInt(r.high, 10), medium: parseInt(r.medium, 10), low,
      avgConfidence: avg, lowRatio: parseFloat(lowRatio.toFixed(4)),
    });
}

// ── SCORING ENGINE ────────────────────────────────────────────────────────────
function computeOverallScore(checks) {
  const byCategory = {};
  for (const c of checks) {
    if (c.status === 'skip') continue;
    (byCategory[c.category] = byCategory[c.category] || []).push(c.score);
  }
  let weightedSum = 0, totalWeight = 0;
  for (const [cat, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    const scores = byCategory[cat];
    if (!scores || scores.length === 0) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    weightedSum += avg * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

function statusLabel(score) {
  if (score >= 85) return 'healthy';
  if (score >= 60) return 'degraded';
  return 'critical';
}

// ── ALERT MANAGEMENT ─────────────────────────────────────────────────────────
async function upsertAlert(key, severity, title, description, checkName) {
  await q(`
    INSERT INTO pie_alerts (alert_key, severity, title, description, check_name)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen   = NOW(),
      severity    = EXCLUDED.severity,
      description = EXCLUDED.description,
      resolved_at = NULL
    WHERE pie_alerts.resolved_at IS NOT NULL
       OR pie_alerts.last_seen < NOW() - INTERVAL '30 minutes'
  `, [key, severity, title, description, checkName]);
}

async function resolveAlert(key) {
  await q(`
    UPDATE pie_alerts SET resolved_at = NOW()
    WHERE alert_key = $1 AND resolved_at IS NULL
  `, [key]);
}

async function processAlerts(checks) {
  for (const c of checks) {
    const key = `pie:${c.name}`;
    if (c.status === 'fail') {
      await upsertAlert(key, 'critical', `FAIL: ${c.name.replace(/_/g, ' ')}`, c.message, c.name);
    } else if (c.status === 'warn') {
      await upsertAlert(key, 'warning',  `WARN: ${c.name.replace(/_/g, ' ')}`, c.message, c.name);
    } else {
      await resolveAlert(key);
    }
  }
}

async function getActiveAlerts() {
  const res = await q(`
    SELECT alert_key, severity, title, description, check_name, first_seen, last_seen
    FROM pie_alerts
    WHERE resolved_at IS NULL
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      last_seen DESC
  `);
  return res.rows;
}

// ── AUTO-REMEDIATION ──────────────────────────────────────────────────────────
async function autoRemediate(checks) {
  const log = [];

  for (const c of checks) {
    if (c.status === 'pass' || c.status === 'skip') continue;

    // Queue placeholder-name deals for re-enrichment
    if (c.name === 'name_quality') {
      const res = await q(`
        UPDATE deals
        SET needs_review = true, updated_at = NOW()
        WHERE status = 'active'
          AND (acquirer = ANY($1) OR target = ANY($1))
          AND needs_review = false
        RETURNING id
      `, [PLACEHOLDERS]);
      if (res.rowCount > 0) {
        await q(`
          INSERT INTO pie_alerts (alert_key, severity, title, description, check_name, auto_remedied)
          VALUES ('pie:auto:enrichment', 'info',
            'Auto-remediation: queued deals for re-enrichment',
            $1, 'name_quality', true)
          ON CONFLICT (alert_key) DO UPDATE SET
            last_seen = NOW(), description = EXCLUDED.description, auto_remedied = true,
            resolved_at = NULL
        `, [`Queued ${res.rowCount} deals with placeholder names for extraction queue`]);
        log.push(`Queued ${res.rowCount} placeholder-name deals for re-enrichment`);
      }
    }

    // Note high duplicate accumulation (dedup scheduler handles actual merge)
    if (c.name === 'dedup_health' && c.detail && c.detail.duplicatePairs > 15) {
      log.push(`High duplicate count (${c.detail.duplicatePairs}) — dedup job will run next cycle`);
    }
  }

  return log;
}

// ── PERSIST TO DB ─────────────────────────────────────────────────────────────
async function persistChecks(checks) {
  for (const c of checks) {
    await q(`
      INSERT INTO pie_checks (check_name, category, status, score, message, detail)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [c.name, c.category, c.status, c.score, c.message, JSON.stringify(c.detail)]);
  }
}

async function persistSnapshot(overallScore, checks, activeAlerts) {
  const counts = checks.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  await q(`
    INSERT INTO pie_health_snapshots
      (overall_score, pass_count, warn_count, fail_count, active_alerts, snapshot)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    overallScore,
    counts.pass || 0,
    counts.warn || 0,
    counts.fail || 0,
    activeAlerts.length,
    JSON.stringify({ checks, alerts: activeAlerts }),
  ]);
}

async function recordMetrics(checks, overallScore) {
  const rows = [
    ['pie_overall_score', overallScore, 'score'],
    ...checks.map(c => [`pie_check_${c.name}`, c.score, 'score']),
  ];
  for (const [name, value, unit] of rows) {
    await q(`INSERT INTO pie_metrics (metric_name, value, unit) VALUES ($1, $2, $3)`,
      [name, value, unit]);
  }
  // Prune old metrics (keep 30 days)
  await q(`DELETE FROM pie_metrics WHERE recorded_at < NOW() - INTERVAL '30 days'`);
  // Prune old check rows (keep 14 days)
  await q(`DELETE FROM pie_checks WHERE checked_at < NOW() - INTERVAL '14 days'`);
  // Prune old snapshots (keep 90 days)
  await q(`DELETE FROM pie_health_snapshots WHERE taken_at < NOW() - INTERVAL '90 days'`);
}

// ── GITHUB EXPORT ─────────────────────────────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization:         `Bearer ${GH_TOKEN}`,
        Accept:                'application/vnd.github+json',
        'Content-Type':        'application/json',
        'User-Agent':          'mawire-pie/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function exportHealthJson(payload) {
  if (!GH_TOKEN) {
    console.log('[PIE] No GitHub token — skipping pie-health.json export');
    return;
  }
  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const message = `pie: health snapshot ${new Date().toISOString().slice(0, 16)}Z`;

  for (const repo of [GH_REPO, GH_SITE]) {
    try {
      const existing = await ghRequest('GET', `/repos/${GH_OWNER}/${repo}/contents/${HEALTH_FILE}`);
      const body = {
        message,
        content,
        ...(existing && existing.sha ? { sha: existing.sha } : {}),
      };
      await ghRequest('PUT', `/repos/${GH_OWNER}/${repo}/contents/${HEALTH_FILE}`, body);
      console.log(`[PIE] Exported pie-health.json to ${repo}`);
    } catch (err) {
      console.error(`[PIE] Export to ${repo} failed:`, err.message);
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log('[PIE] ── Platform Integrity Engine starting ──');

  try {
    await ensureSchema();
  } catch (err) {
    console.error('[PIE] Schema bootstrap failed:', err.message);
    return;
  }

  const checkFns = [
    checkIngestionFreshness,
    checkIngestionVelocity,
    checkSourceDiversity,
    checkFilingCoverage,
    checkNameQuality,
    checkValueCompleteness,
    checkDataCompleteness,
    checkDedupHealth,
    checkExportFreshness,
    checkReviewQueue,
    checkGeographicCoverage,
    checkSectorCoverage,
    checkConfidenceDistribution,
  ];

  const checks = [];
  for (const fn of checkFns) {
    try {
      const result = await fn();
      checks.push(result);
      const icon = { pass: '✓', warn: '⚠', fail: '✗', skip: '–' }[result.status] || '?';
      console.log(`[PIE] ${icon} ${result.name.padEnd(30)} score=${String(result.score).padStart(3)}  ${result.message}`);
    } catch (err) {
      console.error(`[PIE] Error in ${fn.name}:`, err.message);
      checks.push(check(
        fn.name.replace(/^check/, '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''),
        'unknown', 'skip', 50, `Check error: ${err.message}`, {}
      ));
    }
  }

  const overallScore = computeOverallScore(checks);
  const status       = statusLabel(overallScore);
  console.log(`[PIE] ── Overall: ${overallScore}/100 (${status}) ──`);

  await persistChecks(checks);
  await processAlerts(checks);
  const activeAlerts  = await getActiveAlerts();
  const remediations  = await autoRemediate(checks);
  await persistSnapshot(overallScore, checks, activeAlerts);
  await recordMetrics(checks, overallScore);

  if (remediations.length > 0) {
    remediations.forEach(r => console.log(`[PIE] Remediation: ${r}`));
  }
  if (activeAlerts.length > 0) {
    console.log(`[PIE] Active alerts (${activeAlerts.length}):`);
    activeAlerts.forEach(a => console.log(`  [${a.severity.toUpperCase()}] ${a.title}`));
  }

  // Build export payload
  const categoryScores = {};
  for (const cat of Object.keys(CATEGORY_WEIGHTS)) {
    const catChecks = checks.filter(c => c.category === cat && c.status !== 'skip');
    if (catChecks.length === 0) continue;
    const avg = catChecks.reduce((s, c) => s + c.score, 0) / catChecks.length;
    categoryScores[cat] = {
      score:  Math.round(avg),
      status: statusLabel(Math.round(avg)),
      checks: catChecks.map(c => ({ name: c.name, status: c.status, score: c.score, message: c.message })),
    };
  }

  const healthPayload = {
    generatedAt:  new Date().toISOString(),
    overallScore,
    status,
    durationMs:   Date.now() - t0,
    categories:   categoryScores,
    checks:       checks.map(c => ({ name: c.name, category: c.category, status: c.status, score: c.score, message: c.message })),
    alerts:       activeAlerts.map(a => ({ key: a.alert_key, severity: a.severity, title: a.title, description: a.description, since: a.first_seen })),
    summary: {
      pass:     checks.filter(c => c.status === 'pass').length,
      warn:     checks.filter(c => c.status === 'warn').length,
      fail:     checks.filter(c => c.status === 'fail').length,
      skip:     checks.filter(c => c.status === 'skip').length,
      critical: activeAlerts.filter(a => a.severity === 'critical').length,
      warnings: activeAlerts.filter(a => a.severity === 'warning').length,
    },
  };

  try {
    await exportHealthJson(healthPayload);
  } catch (err) {
    console.error('[PIE] Export failed:', err.message);
  }

  console.log(`[PIE] ── Done in ${Date.now() - t0}ms ──`);
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
