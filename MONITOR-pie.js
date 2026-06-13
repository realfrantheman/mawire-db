'use strict';
// Plane A — Database Integrity Engine (fixed schema + fail-loud error handling)
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;

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

// Status values the platform actually writes (never 'active')
const ACTIVE_WHERE = `d.status IN ('Announced', 'Pending')`;

// Placeholder strings stored in the companies table when extraction fails
const PLACEHOLDERS = [
  'Acquirer (see filing)', 'Disclosed in filing',
  'Public company target (see filing)', 'Target (see filing)',
  'Unknown', 'N/A', 'Undisclosed',
];

const CATEGORY_WEIGHTS = { ingestion: 0.35, quality: 0.30, pipeline: 0.20, coverage: 0.15 };

// Fixed category assignment — never 'unknown', used when a check errors
const CHECK_CATEGORIES = {
  ingestion_freshness:      'ingestion',
  ingestion_velocity:       'ingestion',
  source_diversity:         'ingestion',
  filing_coverage:          'ingestion',
  name_quality:             'quality',
  value_completeness:       'quality',
  data_completeness:        'quality',
  dedup_health:             'pipeline',
  export_freshness:         'pipeline',
  review_queue:             'pipeline',
  geographic_coverage:      'coverage',
  sector_coverage:          'coverage',
  confidence_distribution:  'coverage',
};

// ── DB ────────────────────────────────────────────────────────────────────────
let _pool;
function db() {
  if (!_pool) _pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}
async function q(sql, params = []) {
  const c = await db().connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

// ── SCHEMA ────────────────────────────────────────────────────────────────────
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
      error_count   INT DEFAULT 0,
      active_alerts INT DEFAULT 0,
      snapshot      JSONB,
      taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pie_checks_at    ON pie_checks(checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_alerts_open  ON pie_alerts(resolved_at) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pie_metrics_name ON pie_metrics(metric_name, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_snaps_at     ON pie_health_snapshots(taken_at DESC);
  `);
  // Add error_count column if upgrading from old schema
  await q(`ALTER TABLE pie_health_snapshots ADD COLUMN IF NOT EXISTS error_count INT DEFAULT 0`).catch(() => {});
}

// ── RESULT BUILDERS ───────────────────────────────────────────────────────────
function check(name, category, status, score, message, detail = {}) {
  return { name, category, status, score: Math.round(score), message, detail, isError: false };
}
function notApplicable(name, category, message = 'No data') {
  return { name, category, status: 'not_applicable', score: 100, message, detail: {}, isError: false };
}
function errored(name, errMsg) {
  // Errored checks count as fail (score 0) and trigger a critical alert
  return {
    name,
    category: CHECK_CATEGORIES[name] || 'quality',
    status: 'error',
    score: 0,
    message: `Check error: ${errMsg}`,
    detail: {},
    isError: true,
  };
}

// Wrap each check — SQL errors become 'error' status, never silently skipped
async function runCheck(name, fn) {
  try { return await fn(); }
  catch (err) { return errored(name, err.message); }
}

// ── 13 HEALTH CHECKS ─────────────────────────────────────────────────────────

async function checkIngestionFreshness() {
  const res = await q(`
    SELECT MAX(created_at) AS last_deal,
           EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS age_h
    FROM deals
  `);
  const row = res.rows[0];
  if (!row.last_deal) return errored('ingestion_freshness', 'No deals in database');
  const ageH = parseFloat(row.age_h);
  let status = 'pass', score = 100;
  if (ageH > T.freshness_fail_h)      { status = 'fail'; score = 10; }
  else if (ageH > T.freshness_warn_h) { status = 'warn'; score = 55; }
  return check('ingestion_freshness', 'ingestion', status, score,
    `Last deal ingested ${ageH.toFixed(1)}h ago`,
    { lastDeal: row.last_deal, ageHours: parseFloat(ageH.toFixed(2)) });
}

async function checkIngestionVelocity() {
  const res = await q(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')   AS last_7d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')  AS last_30d
    FROM deals
  `);
  const v24 = parseInt(res.rows[0].last_24h, 10);
  const v7d  = parseInt(res.rows[0].last_7d,  10);
  const v30d = parseInt(res.rows[0].last_30d, 10);
  let status = 'pass', score = 100;
  if (v24 <= T.velocity_24h_fail)     { status = 'fail'; score = 5;  }
  else if (v24 < T.velocity_24h_warn) { status = 'warn'; score = 50; }
  return check('ingestion_velocity', 'ingestion', status, score,
    `${v24} deals last 24h · ${v7d} last 7d · ${v30d} last 30d`,
    { last24h: v24, last7d: v7d, last30d: v30d });
}

async function checkSourceDiversity() {
  const res = await q(`
    SELECT ds.source_type, COUNT(DISTINCT d.id) AS cnt
    FROM deal_sources ds
    JOIN deals d ON d.id = ds.deal_id
    WHERE d.created_at > NOW() - INTERVAL '48 hours'
    GROUP BY ds.source_type ORDER BY cnt DESC
  `);
  const active = res.rows.length;
  let status = 'pass', score = 100;
  if (active === 0)                      { status = 'fail'; score = 0;  }
  else if (active < T.source_active_min) { status = 'warn'; score = 50; }
  return check('source_diversity', 'ingestion', status, score,
    `${active} source type(s) active in last 48h`,
    { activeSources: active, sources: res.rows.map(r => ({ type: r.source_type, count: parseInt(r.cnt, 10) })) });
}

async function checkFilingCoverage() {
  const EXPECTED = ['DEFM14A', 'SC TO-T', 'S-4', 'DEFA14A'];
  const res = await q(`
    SELECT filing_type, COUNT(*) AS cnt FROM filings
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

async function checkNameQuality() {
  // Join companies table — deals.acquirer/target columns do not exist
  const res = await q(`
    SELECT
      COUNT(*)                                                               AS total,
      COUNT(*) FILTER (WHERE a.name = ANY($1) OR  t.name = ANY($1))        AS with_placeholder,
      COUNT(*) FILTER (WHERE a.name = ANY($1) AND t.name = ANY($1))        AS both_placeholder
    FROM deals d
    LEFT JOIN companies a ON d.acquirer_id = a.id
    LEFT JOIN companies t ON d.target_id   = t.id
    WHERE ${ACTIVE_WHERE}
  `, [PLACEHOLDERS]);
  const total   = parseInt(res.rows[0].total,            10);
  const bad     = parseInt(res.rows[0].with_placeholder, 10);
  const bothBad = parseInt(res.rows[0].both_placeholder, 10);
  if (total === 0) return notApplicable('name_quality', 'quality', 'No announced/pending deals');
  const ratio = bad / total;
  let status = 'pass', score = 100;
  if (ratio > T.name_placeholder_fail)      { status = 'fail'; score = 20; }
  else if (ratio > T.name_placeholder_warn) { status = 'warn'; score = 60; }
  return check('name_quality', 'quality', status, score,
    `${bad}/${total} active deals (${(ratio * 100).toFixed(1)}%) have placeholder names`,
    { total, withPlaceholder: bad, bothPlaceholder: bothBad, ratio: parseFloat(ratio.toFixed(4)) });
}

async function checkValueCompleteness() {
  const res = await q(`
    SELECT
      COUNT(*)                                                      AS total,
      COUNT(*) FILTER (WHERE deal_value IS NULL OR deal_value = 0) AS missing
    FROM deals d
    WHERE ${ACTIVE_WHERE}
  `);
  const total   = parseInt(res.rows[0].total,   10);
  const missing = parseInt(res.rows[0].missing, 10);
  if (total === 0) return notApplicable('value_completeness', 'quality', 'No announced/pending deals');
  const ratio = missing / total;
  let status = 'pass', score = 100;
  if (ratio > T.value_missing_fail)      { status = 'fail'; score = 30; }
  else if (ratio > T.value_missing_warn) { status = 'warn'; score = 65; }
  return check('value_completeness', 'quality', status, score,
    `${missing}/${total} active deals (${(ratio * 100).toFixed(1)}%) missing deal value`,
    { total, missing, ratio: parseFloat(ratio.toFixed(4)) });
}

async function checkDataCompleteness() {
  const res = await q(`
    SELECT
      COUNT(*)                                                                AS total,
      COUNT(*) FILTER (WHERE d.sector   IS NOT NULL AND d.sector   <> '')   AS has_sector,
      COUNT(*) FILTER (WHERE d.region   IS NOT NULL AND d.region   <> '')   AS has_region,
      COUNT(*) FILTER (WHERE d.country  IS NOT NULL AND d.country  <> '')   AS has_country,
      COUNT(*) FILTER (WHERE d.headline IS NOT NULL AND LENGTH(d.headline) > 20) AS has_headline
    FROM deals d
    WHERE ${ACTIVE_WHERE}
  `);
  const r     = res.rows[0];
  const total = parseInt(r.total, 10);
  if (total === 0) return notApplicable('data_completeness', 'quality', 'No announced/pending deals');
  const fields = ['has_sector', 'has_region', 'has_country', 'has_headline'];
  const scores = fields.map(f => parseInt(r[f], 10) / total);
  const avgFill = scores.reduce((a, b) => a + b, 0) / fields.length;
  let status = 'pass', score = Math.round(avgFill * 100);
  if (avgFill < 0.60)      { status = 'fail'; }
  else if (avgFill < 0.80) { status = 'warn'; }
  return check('data_completeness', 'quality', status, score,
    `${(avgFill * 100).toFixed(1)}% avg field completeness across active deals`,
    {
      total,
      sector:   parseFloat((parseInt(r.has_sector,   10) / total).toFixed(3)),
      region:   parseFloat((parseInt(r.has_region,   10) / total).toFixed(3)),
      country:  parseFloat((parseInt(r.has_country,  10) / total).toFixed(3)),
      headline: parseFloat((parseInt(r.has_headline, 10) / total).toFixed(3)),
    });
}

async function checkDedupHealth() {
  // Join companies to find near-duplicate deals by company name pairs
  const res = await q(`
    SELECT COUNT(*) AS dup_pairs FROM (
      SELECT a.id
      FROM deals a
      JOIN deals b ON b.id > a.id
      JOIN companies ac1 ON a.acquirer_id = ac1.id
      JOIN companies tc1 ON a.target_id   = tc1.id
      JOIN companies ac2 ON b.acquirer_id = ac2.id
      JOIN companies tc2 ON b.target_id   = tc2.id
      WHERE LOWER(ac1.name) = LOWER(ac2.name)
        AND LOWER(tc1.name) = LOWER(tc2.name)
        AND ac1.name <> 'Unknown' AND ac1.name <> 'Undisclosed'
        AND tc1.name <> 'Unknown' AND tc1.name <> 'Undisclosed'
        AND ABS(EXTRACT(EPOCH FROM (a.created_at - b.created_at))) < 21600
      LIMIT 500
    ) pairs
  `);
  const dups = parseInt(res.rows[0].dup_pairs, 10);
  let status = 'pass', score = 100;
  if (dups > 50)      { status = 'fail'; score = 20; }
  else if (dups > 15) { status = 'warn'; score = 60; }
  return check('dedup_health', 'pipeline', status, score,
    `${dups} potential duplicate deal pairs detected`, { duplicatePairs: dups });
}

async function checkExportFreshness() {
  const cached = await q(`
    SELECT value::text AS ts FROM stats_cache WHERE key = 'last_github_export' LIMIT 1
  `).catch(() => ({ rows: [] }));

  let ageH, source;
  if (cached.rows.length > 0) {
    ageH = (Date.now() - new Date(cached.rows[0].ts).getTime()) / 3_600_000;
    source = 'stats_cache';
  } else {
    const proxy = await q(`SELECT MAX(updated_at) AS t FROM deals`);
    if (!proxy.rows[0].t) return notApplicable('export_freshness', 'pipeline', 'Cannot determine export freshness');
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

async function checkReviewQueue() {
  const res = await q(`
    SELECT
      COUNT(*) FILTER (WHERE d.needs_review = true) AS needs_review,
      COUNT(*)                                      AS total
    FROM deals d
    WHERE ${ACTIVE_WHERE}
  `);
  const queueSize = parseInt(res.rows[0].needs_review, 10);
  const total     = parseInt(res.rows[0].total,        10);
  if (total === 0) return notApplicable('review_queue', 'pipeline', 'No announced/pending deals');
  let status = 'pass', score = 100;
  if (queueSize > T.review_fail)      { status = 'fail'; score = 10; }
  else if (queueSize > T.review_warn) { status = 'warn'; score = 55; }
  return check('review_queue', 'pipeline', status, score,
    `${queueSize} of ${total} active deals need review`, { queueSize, totalActive: total });
}

async function checkGeographicCoverage() {
  const res = await q(`
    SELECT
      COUNT(*)                                                              AS total,
      COUNT(*) FILTER (WHERE d.region IS NOT NULL AND d.region <> '')      AS with_region,
      COUNT(DISTINCT d.region) FILTER (WHERE d.region IS NOT NULL AND d.region <> '') AS distinct_regions
    FROM deals d
    WHERE ${ACTIVE_WHERE}
  `);
  const r       = res.rows[0];
  const total   = parseInt(r.total,            10);
  const covered = parseInt(r.with_region,      10);
  const regions = parseInt(r.distinct_regions, 10);
  if (total === 0) return notApplicable('geographic_coverage', 'coverage', 'No announced/pending deals');
  const coverageRatio = covered / total;
  let status = 'pass', score = Math.min(100, Math.round(coverageRatio * 100 * (regions >= 3 ? 1 : 0.7)));
  if (regions < 2 || coverageRatio < 0.5) { status = 'warn'; score = Math.min(score, 60); }
  const topRes = await q(`
    SELECT d.region, COUNT(*) AS cnt FROM deals d
    WHERE ${ACTIVE_WHERE} AND d.region IS NOT NULL AND d.region <> ''
    GROUP BY d.region ORDER BY cnt DESC LIMIT 8
  `);
  return check('geographic_coverage', 'coverage', status, score,
    `${regions} region(s) · ${covered}/${total} deals have region set`,
    { total, withRegion: covered, distinctRegions: regions,
      topRegions: topRes.rows.map(r2 => ({ region: r2.region, count: parseInt(r2.cnt, 10) })) });
}

async function checkSectorCoverage() {
  const res = await q(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT d.sector) FILTER (WHERE d.sector IS NOT NULL AND d.sector <> '') AS distinct_sectors
    FROM deals d
    WHERE ${ACTIVE_WHERE}
  `);
  const total   = parseInt(res.rows[0].total,            10);
  const sectors = parseInt(res.rows[0].distinct_sectors, 10);
  if (total === 0) return notApplicable('sector_coverage', 'coverage', 'No announced/pending deals');
  let status = 'pass', score = 100;
  if (sectors < 2) { status = 'warn'; score = 45; }
  const topRes = await q(`
    SELECT d.sector, COUNT(*) AS cnt FROM deals d
    WHERE ${ACTIVE_WHERE} AND d.sector IS NOT NULL AND d.sector <> ''
    GROUP BY d.sector ORDER BY cnt DESC LIMIT 8
  `);
  return check('sector_coverage', 'coverage', status, score,
    `${sectors} sector(s) represented in active deals`,
    { distinctSectors: sectors, topSectors: topRes.rows.map(r => ({ sector: r.sector, count: parseInt(r.cnt, 10) })) });
}

async function checkConfidenceDistribution() {
  // source_confidence is the actual column name (aliased as 'confidence' only in exports)
  const res = await q(`
    SELECT
      COUNT(*)                                                                         AS total,
      COUNT(*) FILTER (WHERE d.source_confidence >= 0.85)                            AS high,
      COUNT(*) FILTER (WHERE d.source_confidence >= 0.70 AND d.source_confidence < 0.85) AS medium,
      COUNT(*) FILTER (WHERE d.source_confidence < 0.70)                             AS low,
      ROUND(AVG(d.source_confidence)::numeric, 3)                                    AS avg_conf
    FROM deals d
    WHERE ${ACTIVE_WHERE} AND d.source_confidence IS NOT NULL
  `);
  const r     = res.rows[0];
  const total = parseInt(r.total, 10);
  if (total === 0) return notApplicable('confidence_distribution', 'coverage', 'No active deals with confidence scores');
  const low      = parseInt(r.low, 10);
  const lowRatio = low / total;
  const avg      = parseFloat(r.avg_conf);
  let status = 'pass', score = 100;
  if (lowRatio > T.confidence_low_fail)      { status = 'fail'; score = 30; }
  else if (lowRatio > T.confidence_low_warn) { status = 'warn'; score = 65; }
  return check('confidence_distribution', 'coverage', status, score,
    `Avg confidence ${avg} · ${low}/${total} (${(lowRatio * 100).toFixed(1)}%) below 0.70`,
    { total, high: parseInt(r.high, 10), medium: parseInt(r.medium, 10), low, avgConfidence: avg, lowRatio: parseFloat(lowRatio.toFixed(4)) });
}

// ── SCORING ───────────────────────────────────────────────────────────────────
function computeOverallScore(checks) {
  const byCategory = {};
  for (const c of checks) {
    if (c.status === 'not_applicable') continue;  // legitimately no data
    const score = c.isError ? 0 : c.score;        // error = fail = 0
    (byCategory[c.category] = byCategory[c.category] || []).push(score);
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

// ── ALERTS ────────────────────────────────────────────────────────────────────
async function upsertAlert(key, severity, title, description, checkName) {
  await q(`
    INSERT INTO pie_alerts (alert_key, severity, title, description, check_name)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen   = NOW(), severity = EXCLUDED.severity, description = EXCLUDED.description,
      resolved_at = NULL
    WHERE pie_alerts.resolved_at IS NOT NULL
       OR pie_alerts.last_seen < NOW() - INTERVAL '30 minutes'
  `, [key, severity, title, description, checkName]);
}

async function resolveAlert(key) {
  await q(`UPDATE pie_alerts SET resolved_at = NOW() WHERE alert_key = $1 AND resolved_at IS NULL`, [key]);
}

async function processAlerts(checks) {
  for (const c of checks) {
    const key = `pie:${c.name}`;
    if (c.status === 'fail' || c.isError) {
      const severity = c.isError ? 'critical' : 'critical';
      const prefix   = c.isError ? 'ERROR' : 'FAIL';
      await upsertAlert(key, severity, `${prefix}: ${c.name.replace(/_/g, ' ')}`, c.message, c.name);
    } else if (c.status === 'warn') {
      await upsertAlert(key, 'warning', `WARN: ${c.name.replace(/_/g, ' ')}`, c.message, c.name);
    } else {
      await resolveAlert(key);
    }
  }
}

async function getActiveAlerts() {
  const res = await q(`
    SELECT alert_key, severity, title, description, check_name, first_seen, last_seen
    FROM pie_alerts WHERE resolved_at IS NULL
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC
  `);
  return res.rows;
}

// ── AUTO-REMEDIATION ──────────────────────────────────────────────────────────
async function autoRemediate(checks) {
  const log = [];
  for (const c of checks) {
    if (c.status === 'pass' || c.status === 'not_applicable' || c.isError) continue;

    if (c.name === 'name_quality') {
      // Queue placeholder-named deals for re-enrichment via companies join
      const res = await q(`
        UPDATE deals d
        SET needs_review = true, updated_at = NOW()
        FROM companies a, companies t
        WHERE d.acquirer_id = a.id AND d.target_id = t.id
          AND ${ACTIVE_WHERE.replace(/\bd\./g, 'd.')}
          AND (a.name = ANY($1) OR t.name = ANY($1))
          AND d.needs_review = false
        RETURNING d.id
      `, [PLACEHOLDERS]);
      if (res.rowCount > 0) {
        await q(`
          INSERT INTO pie_alerts (alert_key, severity, title, description, check_name, auto_remedied)
          VALUES ('pie:auto:enrichment','info','Auto-remediation: queued for re-enrichment',$1,'name_quality',true)
          ON CONFLICT (alert_key) DO UPDATE SET
            last_seen=NOW(), description=EXCLUDED.description, auto_remedied=true, resolved_at=NULL
        `, [`Queued ${res.rowCount} deals with placeholder names for extraction queue`]);
        log.push(`Queued ${res.rowCount} placeholder-name deals for re-enrichment`);
      }
    }

    if (c.name === 'dedup_health' && c.detail && c.detail.duplicatePairs > 15) {
      log.push(`High duplicate count (${c.detail.duplicatePairs}) — dedup job will run next cycle`);
    }
  }
  return log;
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
async function persistChecks(checks) {
  for (const c of checks) {
    await q(`INSERT INTO pie_checks (check_name, category, status, score, message, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.name, c.category, c.status, c.score, c.message, JSON.stringify(c.detail)]);
  }
}

async function persistSnapshot(overallScore, checks, activeAlerts) {
  const counts = checks.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  await q(`
    INSERT INTO pie_health_snapshots (overall_score, pass_count, warn_count, fail_count, error_count, active_alerts, snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [overallScore, counts.pass||0, counts.warn||0, counts.fail||0, counts.error||0, activeAlerts.length,
      JSON.stringify({ checks, alerts: activeAlerts })]);
}

async function recordMetrics(checks, overallScore) {
  const rows = [['pie_overall_score', overallScore, 'score'], ...checks.map(c => [`pie_check_${c.name}`, c.score, 'score'])];
  for (const [name, value, unit] of rows) {
    await q(`INSERT INTO pie_metrics (metric_name, value, unit) VALUES ($1,$2,$3)`, [name, value, unit]);
  }
  await q(`DELETE FROM pie_metrics WHERE recorded_at < NOW() - INTERVAL '30 days'`);
  await q(`DELETE FROM pie_checks WHERE checked_at < NOW() - INTERVAL '14 days'`);
  await q(`DELETE FROM pie_health_snapshots WHERE taken_at < NOW() - INTERVAL '90 days'`);
}

// ── RUN ───────────────────────────────────────────────────────────────────────
async function run() {
  if (!DB_URL) throw new Error('DATABASE_URL not set');
  await ensureSchema();

  const checkDefs = [
    ['ingestion_freshness',     checkIngestionFreshness],
    ['ingestion_velocity',      checkIngestionVelocity],
    ['source_diversity',        checkSourceDiversity],
    ['filing_coverage',         checkFilingCoverage],
    ['name_quality',            checkNameQuality],
    ['value_completeness',      checkValueCompleteness],
    ['data_completeness',       checkDataCompleteness],
    ['dedup_health',            checkDedupHealth],
    ['export_freshness',        checkExportFreshness],
    ['review_queue',            checkReviewQueue],
    ['geographic_coverage',     checkGeographicCoverage],
    ['sector_coverage',         checkSectorCoverage],
    ['confidence_distribution', checkConfidenceDistribution],
  ];

  const checks = [];
  for (const [name, fn] of checkDefs) {
    const result = await runCheck(name, fn);
    const icon = { pass: '✓', warn: '⚠', fail: '✗', not_applicable: '–', error: '✗✗' }[result.status] || '?';
    console.log(`[PIE] ${icon} ${result.name.padEnd(28)} score=${String(result.score).padStart(3)}  ${result.message}`);
    checks.push(result);
  }

  const overallScore = computeOverallScore(checks);
  const status       = statusLabel(overallScore);
  console.log(`[PIE] ── Overall: ${overallScore}/100 (${status}) ──`);
  if (checks.some(c => c.isError)) {
    console.log(`[PIE] ⚠ ${checks.filter(c => c.isError).length} check(s) errored — those categories are penalized`);
  }

  await persistChecks(checks);
  await processAlerts(checks);
  const activeAlerts = await getActiveAlerts();
  const remediations = await autoRemediate(checks);
  await persistSnapshot(overallScore, checks, activeAlerts);
  await recordMetrics(checks, overallScore);

  if (remediations.length) remediations.forEach(r => console.log(`[PIE] Remediation: ${r}`));
  if (activeAlerts.length) {
    console.log(`[PIE] Active alerts (${activeAlerts.length}):`);
    activeAlerts.forEach(a => console.log(`  [${a.severity.toUpperCase()}] ${a.title}`));
  }

  const categoryScores = {};
  for (const cat of Object.keys(CATEGORY_WEIGHTS)) {
    const catChecks = checks.filter(c => c.category === cat && c.status !== 'not_applicable');
    if (!catChecks.length) continue;
    const avg = catChecks.reduce((s, c) => s + (c.isError ? 0 : c.score), 0) / catChecks.length;
    categoryScores[cat] = {
      score:  Math.round(avg),
      status: statusLabel(Math.round(avg)),
      checks: catChecks.map(c => ({ name: c.name, status: c.status, score: c.score, message: c.message })),
    };
  }

  return {
    overallScore,
    status,
    categoryScores,
    checks: checks.map(c => ({ name: c.name, category: c.category, status: c.status, score: c.score, message: c.message, isError: c.isError })),
    activeAlerts: activeAlerts.map(a => ({ key: a.alert_key, severity: a.severity, title: a.title, description: a.description, since: a.first_seen })),
    summary: {
      pass:          checks.filter(c => c.status === 'pass').length,
      warn:          checks.filter(c => c.status === 'warn').length,
      fail:          checks.filter(c => c.status === 'fail').length,
      error:         checks.filter(c => c.isError).length,
      not_applicable: checks.filter(c => c.status === 'not_applicable').length,
      critical:      activeAlerts.filter(a => a.severity === 'critical').length,
      warnings:      activeAlerts.filter(a => a.severity === 'warning').length,
    },
  };
}

module.exports = { run };
