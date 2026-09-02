'use strict';

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
const GH_TOKEN = process.env.MAWIRE_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'realfrantheman';
const REPO = 'mawire-db';
const REVIEW_RULE = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';

const db = new Pool({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 3,
  statement_timeout: 45000,
  query_timeout: 45000,
});
db.on('error', error => console.error('[PIE] idle database client error:', error.message));

async function q(sql, params = []) {
  return db.query(sql, params);
}

function result(name, category, status, score, message, detail = {}, hard = false) {
  return { name, category, status, score, message, detail, hard };
}

function pass(name, category, message, detail = {}) {
  return result(name, category, 'pass', 100, message, detail, false);
}
function warn(name, category, score, message, detail = {}) {
  return result(name, category, 'warn', score, message, detail, false);
}
function fail(name, category, message, detail = {}) {
  return result(name, category, 'fail', 0, message, detail, true);
}

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS pie_checks (
      id SERIAL PRIMARY KEY,
      check_name VARCHAR(80) NOT NULL,
      category VARCHAR(40) NOT NULL,
      status VARCHAR(10) NOT NULL,
      score NUMERIC(5,2),
      message TEXT,
      detail JSONB,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pie_alerts (
      id SERIAL PRIMARY KEY,
      alert_key VARCHAR(150) NOT NULL UNIQUE,
      severity VARCHAR(20) NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      check_name VARCHAR(80),
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      auto_remedied BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS pie_health_snapshots (
      id SERIAL PRIMARY KEY,
      overall_score NUMERIC(5,2),
      pass_count INT DEFAULT 0,
      warn_count INT DEFAULT 0,
      fail_count INT DEFAULT 0,
      active_alerts INT DEFAULT 0,
      snapshot JSONB,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pie_checks_checked_at ON pie_checks(checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_snapshots_taken_at ON pie_health_snapshots(taken_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pie_alerts_open ON pie_alerts(last_seen DESC) WHERE resolved_at IS NULL;
  `);
}

async function cleanupHistory() {
  await q("DELETE FROM pie_checks WHERE checked_at < NOW() - INTERVAL '30 days'");
  await q("DELETE FROM pie_health_snapshots WHERE taken_at < NOW() - INTERVAL '90 days'");
  await q("DELETE FROM pie_alerts WHERE resolved_at IS NOT NULL AND resolved_at < NOW() - INTERVAL '90 days'");
}

async function githubJson(path) {
  if (!GH_TOKEN) throw new Error('MAWIRE_TOKEN/GITHUB_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mergers.news-pie',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return response.json();
}

async function readGithubJsonFile(path) {
  const file = await githubJson(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=main`);
  if (!file?.content) throw new Error(`${path} has no readable GitHub contents payload`);
  const text = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(text);
}

async function databaseConnectivity() {
  const started = Date.now();
  await q('SELECT 1');
  return pass('database_connectivity', 'infrastructure', `Database reachable in ${Date.now() - started}ms`, { latencyMs: Date.now() - started });
}

async function schedulerHeartbeat() {
  const row = (await q(`SELECT computed_at,EXTRACT(EPOCH FROM (NOW()-computed_at))/60 AS age_minutes FROM stats_cache WHERE key='scheduler_heartbeat'`)).rows[0];
  if (!row) return fail('scheduler_heartbeat', 'pipeline', 'Scheduler heartbeat is missing');
  const age = Number(row.age_minutes);
  if (age > 10) return fail('scheduler_heartbeat', 'pipeline', `Scheduler heartbeat is ${age.toFixed(1)} minutes old`, { ageMinutes: age });
  if (age > 4) return warn('scheduler_heartbeat', 'pipeline', 65, `Scheduler heartbeat is ${age.toFixed(1)} minutes old`, { ageMinutes: age });
  return pass('scheduler_heartbeat', 'pipeline', `Scheduler heartbeat ${age.toFixed(1)} minutes ago`, { ageMinutes: age });
}

async function secIngestionFreshness() {
  const row = (await q(`
    SELECT
      MAX(run_ended_at) FILTER (WHERE status='success') AS last_success,
      MAX(run_started_at) AS last_run,
      (ARRAY_AGG(status ORDER BY run_started_at DESC))[1] AS latest_status
    FROM ingestion_log
    WHERE source='sec_edgar'
  `)).rows[0];
  if (!row?.last_success) return fail('sec_ingestion_freshness', 'ingestion', 'SEC ingestion has no successful recorded run');
  const age = (Date.now() - new Date(row.last_success).getTime()) / 3600000;
  if (age > 2) return fail('sec_ingestion_freshness', 'ingestion', `Last successful SEC ingestion was ${age.toFixed(1)}h ago`, { ageHours: age, latestStatus: row.latest_status });
  if (row.latest_status === 'failed' || age > 1) return warn('sec_ingestion_freshness', 'ingestion', 65, `SEC last success ${age.toFixed(1)}h ago; latest status ${row.latest_status}`, { ageHours: age, latestStatus: row.latest_status });
  return pass('sec_ingestion_freshness', 'ingestion', `SEC ingestion succeeded ${age.toFixed(1)}h ago`, { ageHours: age, latestStatus: row.latest_status });
}

async function secondaryIngestionHealth() {
  const expected = [
    { source: 'gdelt', maxHours: 3 },
    { source: 'news_rss', maxHours: 5 },
    { source: 'news', maxHours: 5 },
    { source: 'apac', maxHours: 10 },
    { source: 'eu', maxHours: 26 },
  ];
  const rows = (await q(`
    SELECT source,MAX(run_ended_at) FILTER(WHERE status='success') AS last_success,
           MAX(run_started_at) AS last_run,
           (ARRAY_AGG(status ORDER BY run_started_at DESC))[1] AS latest_status
    FROM ingestion_log
    WHERE source=ANY($1::text[])
    GROUP BY source
  `, [expected.map(item => item.source)])).rows;
  const bySource = new Map(rows.map(row => [row.source, row]));
  const groups = [
    { label: 'GDELT', aliases: ['gdelt'], maxHours: 3 },
    { label: 'News', aliases: ['news_rss', 'news'], maxHours: 5 },
    { label: 'APAC', aliases: ['apac'], maxHours: 10 },
    { label: 'EU', aliases: ['eu'], maxHours: 26 },
  ];
  const stale = [];
  const detail = {};
  for (const group of groups) {
    const candidates = group.aliases.map(alias => bySource.get(alias)).filter(Boolean);
    const row = candidates.sort((a, b) => new Date(b.last_success || 0) - new Date(a.last_success || 0))[0];
    if (!row?.last_success) {
      stale.push(`${group.label}: no successful run`);
      detail[group.label] = { ageHours: null, latestStatus: row?.latest_status || null };
      continue;
    }
    const age = (Date.now() - new Date(row.last_success).getTime()) / 3600000;
    detail[group.label] = { ageHours: age, latestStatus: row.latest_status };
    if (age > group.maxHours || row.latest_status === 'failed') stale.push(`${group.label}: ${age.toFixed(1)}h / ${row.latest_status}`);
  }
  if (stale.length) return warn('secondary_ingestion_health', 'ingestion', 60, stale.join(' · '), detail);
  return pass('secondary_ingestion_health', 'ingestion', 'Secondary ingestion jobs are within expected run windows', detail);
}

async function refreshWorkflowFreshness() {
  const runs = await githubJson(`/repos/${OWNER}/${REPO}/actions/workflows/refresh-deals.yml/runs?branch=main&per_page=20`);
  const list = Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
  const latest = list[0];
  const success = list.find(run => run.conclusion === 'success');
  if (!success) return fail('refresh_workflow', 'publication', 'Verified public refresh has no recent successful workflow run', { latestConclusion: latest?.conclusion || null });
  const age = (Date.now() - new Date(success.updated_at || success.created_at).getTime()) / 3600000;
  if (age > 4) return fail('refresh_workflow', 'publication', `Last successful verified public refresh was ${age.toFixed(1)}h ago`, { ageHours: age, latestConclusion: latest?.conclusion || null, runId: success.id });
  if (latest?.conclusion && latest.conclusion !== 'success') return warn('refresh_workflow', 'publication', 60, `Latest refresh concluded ${latest.conclusion}; last success ${age.toFixed(1)}h ago`, { ageHours: age, latestConclusion: latest.conclusion, runId: latest.id });
  if (age > 2.5) return warn('refresh_workflow', 'publication', 70, `Last successful verified public refresh was ${age.toFixed(1)}h ago`, { ageHours: age, runId: success.id });
  return pass('refresh_workflow', 'publication', `Verified public refresh succeeded ${age.toFixed(1)}h ago`, { ageHours: age, runId: success.id });
}

async function publicManifestFreshness() {
  const manifest = await readGithubJsonFile('deals-public-manifest.json');
  const generated = new Date(manifest.generatedAt || manifest.generated_at || 0);
  if (Number.isNaN(generated.getTime())) return fail('public_manifest', 'publication', 'Public manifest has no valid generatedAt timestamp');
  const age = (Date.now() - generated.getTime()) / 3600000;
  const dealCount = Number(manifest.dealCount ?? manifest.deal_count ?? 0);
  if (!Number.isFinite(dealCount) || dealCount <= 0) return fail('public_manifest', 'publication', 'Public manifest reports zero deals', { dealCount, ageHours: age });
  if (age > 4) return fail('public_manifest', 'publication', `Public manifest is ${age.toFixed(1)}h old`, { ageHours: age, dealCount });
  if (age > 2.5) return warn('public_manifest', 'publication', 70, `Public manifest is ${age.toFixed(1)}h old`, { ageHours: age, dealCount });
  return pass('public_manifest', 'publication', `Public manifest is ${age.toFixed(1)}h old with ${dealCount.toLocaleString()} deals`, { ageHours: age, dealCount });
}

async function verifiedPopulationIntegrity() {
  const row = (await q(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE d.acquirer_id IS NULL OR d.target_id IS NULL OR d.acquirer_id=d.target_id)::int AS invalid_parties,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(a.name,d.extracted_acquirer_name,'')),'') IS NULL OR NULLIF(TRIM(COALESCE(t.name,d.extracted_target_name,'')),'') IS NULL)::int AS missing_names,
      COUNT(*) FILTER (WHERE COALESCE(a.name,d.extracted_acquirer_name,'') ~* '^(unknown|undisclosed|n/a|acquirer.*see filing|disclosed in filing)$' OR COALESCE(t.name,d.extracted_target_name,'') ~* '^(unknown|undisclosed|n/a|target.*see filing|disclosed in filing)$')::int AS placeholder_names,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(tr.evidence_url),'') IS NULL OR tr.evidence_url ~* '(browse-edgar|search-index|-index\\.html?$)')::int AS invalid_evidence
    FROM deals d
    JOIN deal_transaction_reviews tr ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version=$1
    LEFT JOIN companies a ON a.id=d.acquirer_id
    LEFT JOIN companies t ON t.id=d.target_id
    WHERE d.canonical_id IS NULL
  `, [REVIEW_RULE])).rows[0];
  const detail = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  if (!detail.total) return fail('verified_population_integrity', 'publication', 'No verified deals are available for publication', detail);
  const bad = detail.invalid_parties + detail.missing_names + detail.placeholder_names + detail.invalid_evidence;
  if (bad > 0) return fail('verified_population_integrity', 'publication', `Verified publication population contains ${bad} invariant violation(s)`, detail);
  return pass('verified_population_integrity', 'publication', `${detail.total.toLocaleString()} verified deals satisfy publication invariants`, detail);
}

async function sourceUrlQuality() {
  const row = (await q(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER(WHERE NULLIF(TRIM(COALESCE(tr.evidence_url,ds.source_url,f.document_url,'')),'') IS NULL)::int AS missing,
           COUNT(*) FILTER(WHERE COALESCE(tr.evidence_url,ds.source_url,f.document_url,'') ~* '(browse-edgar|search-index|-index\\.html?$|/Archives/edgar/data/[0-9]+/[0-9]+/?$)')::int AS indirect
    FROM deals d
    JOIN deal_transaction_reviews tr ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version=$1
    LEFT JOIN LATERAL(
      SELECT source_url FROM deal_sources WHERE deal_id=d.id
      ORDER BY confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id LIMIT 1
    ) ds ON true
    LEFT JOIN LATERAL(
      SELECT document_url FROM filings WHERE deal_id=d.id
      ORDER BY filing_date DESC NULLS LAST,created_at DESC,id LIMIT 1
    ) f ON true
    WHERE d.canonical_id IS NULL
  `, [REVIEW_RULE])).rows[0];
  const total = Number(row.total), missing = Number(row.missing), indirect = Number(row.indirect);
  const ratio = total ? (missing + indirect) / total : 1;
  if (missing + indirect > 0) return fail('source_url_quality', 'publication', `${missing} verified deals lack a source URL; ${indirect} use indirect/landing URLs`, { total, missing, indirect, ratio });
  return pass('source_url_quality', 'publication', `All ${total.toLocaleString()} verified deals have specific source URLs`, { total, missing, indirect, ratio });
}

async function reviewQueueHealth() {
  const row = (await q(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER(WHERE COALESCE(review_status,'pending') IN('pending','retry'))::int AS actionable,
           COUNT(*) FILTER(WHERE COALESCE(review_status,'pending') IN('pending','retry') AND COALESCE(next_review_at,updated_at)<NOW()-INTERVAL '24 hours')::int AS overdue,
           COALESCE(MAX(EXTRACT(EPOCH FROM(NOW()-updated_at))/86400),0) AS oldest_days
    FROM deals
    WHERE canonical_id IS NULL AND needs_review=true
  `)).rows[0];
  const detail = { total: Number(row.total), actionable: Number(row.actionable), overdue: Number(row.overdue), oldestDays: Number(row.oldest_days) };
  if (detail.overdue > 100 || detail.oldestDays > 45) return warn('review_queue_health', 'quality', 50, `${detail.overdue} actionable review items are >24h overdue; oldest retained candidate ${detail.oldestDays.toFixed(1)}d`, detail);
  if (detail.overdue > 0) return warn('review_queue_health', 'quality', 75, `${detail.overdue} actionable review items are >24h overdue`, detail);
  return pass('review_queue_health', 'quality', `${detail.actionable} actionable review items; none >24h overdue`, detail);
}

async function duplicateHealth() {
  const row = (await q(`
    SELECT COUNT(*)::int AS duplicate_groups,COALESCE(SUM(n-1),0)::int AS extra_rows
    FROM (
      SELECT acquirer_id,target_id,announcement_date,COUNT(*)::int AS n
      FROM deals
      WHERE canonical_id IS NULL AND acquirer_id IS NOT NULL AND target_id IS NOT NULL AND announcement_date IS NOT NULL
      GROUP BY acquirer_id,target_id,announcement_date
      HAVING COUNT(*)>1
      LIMIT 1000
    ) grouped
  `)).rows[0];
  const groups = Number(row.duplicate_groups), extraRows = Number(row.extra_rows);
  if (groups > 50) return warn('dedup_health', 'quality', 50, `${groups} duplicate party/date groups (${extraRows} extra rows) need canonicalization`, { groups, extraRows });
  if (groups > 10) return warn('dedup_health', 'quality', 75, `${groups} potential duplicate party/date groups`, { groups, extraRows });
  return pass('dedup_health', 'quality', `${groups} potential duplicate party/date groups`, { groups, extraRows });
}

async function ingestionVelocity() {
  const row = (await q(`SELECT COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '24 hours')::int AS n24,COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '7 days')::int AS n7 FROM deals`)).rows[0];
  const n24 = Number(row.n24), n7 = Number(row.n7);
  if (n24 === 0) return warn('ingestion_velocity', 'coverage', 70, `No new deal rows in 24h; ${n7} in 7d (informational market-volume warning)`, { n24, n7 });
  if (n24 < 3) return warn('ingestion_velocity', 'coverage', 85, `${n24} new deal rows in 24h; ${n7} in 7d`, { n24, n7 });
  return pass('ingestion_velocity', 'coverage', `${n24} new deal rows in 24h; ${n7} in 7d`, { n24, n7 });
}

async function sourceDiversity() {
  const rows = (await q(`SELECT ds.source_type,COUNT(*)::int AS count FROM deal_sources ds JOIN deals d ON d.id=ds.deal_id WHERE ds.created_at>NOW()-INTERVAL '48 hours' GROUP BY ds.source_type ORDER BY count DESC`)).rows;
  if (!rows.length) return warn('source_diversity', 'coverage', 60, 'No source rows were created in the last 48h', { sources: [] });
  if (rows.length < 2) return warn('source_diversity', 'coverage', 80, `Only ${rows.length} source type was active in the last 48h`, { sources: rows });
  return pass('source_diversity', 'coverage', `${rows.length} source types active in the last 48h`, { sources: rows });
}

async function filingCoverage() {
  const rows = (await q(`SELECT filing_type FROM filings WHERE created_at>NOW()-INTERVAL '7 days' GROUP BY filing_type`)).rows.map(row => row.filing_type);
  const expectedGroups = [
    ['DEFM14A', 'PREM14A', 'DEFA14A'],
    ['SC TO-T', 'SC TO-T/A'],
    ['S-4', 'S-4/A'],
    ['SC 13E-3', 'SC 13E-3/A'],
  ];
  const missing = expectedGroups.filter(group => !group.some(form => rows.includes(form))).map(group => group.join('/'));
  if (missing.length >= 3) return warn('filing_coverage', 'coverage', 55, `No recent filings from ${missing.join(', ')}`, { missing, observed: rows });
  if (missing.length) return warn('filing_coverage', 'coverage', 80, `No recent filings from ${missing.join(', ')}`, { missing, observed: rows });
  return pass('filing_coverage', 'coverage', 'All SEC transaction-form families observed in the last 7d', { observed: rows });
}

async function confidenceDistribution() {
  const row = (await q(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE source_confidence<0.70)::int AS low,ROUND(AVG(source_confidence)::numeric,3) AS avg FROM deals WHERE canonical_id IS NULL AND needs_review=true AND source_confidence IS NOT NULL`)).rows[0];
  const total = Number(row.total), low = Number(row.low), average = Number(row.avg || 0), ratio = total ? low / total : 0;
  if (ratio > 0.45) return warn('confidence_distribution', 'coverage', 60, `Review population avg confidence ${average}; ${(ratio * 100).toFixed(1)}% below 0.70`, { total, low, ratio, average });
  if (ratio > 0.25) return warn('confidence_distribution', 'coverage', 80, `Review population avg confidence ${average}; ${(ratio * 100).toFixed(1)}% below 0.70`, { total, low, ratio, average });
  return pass('confidence_distribution', 'coverage', `Review population avg confidence ${average}; ${(ratio * 100).toFixed(1)}% below 0.70`, { total, low, ratio, average });
}

function checkDefinitions() {
  return [
    ['database_connectivity', 'infrastructure', databaseConnectivity, true],
    ['scheduler_heartbeat', 'pipeline', schedulerHeartbeat, true],
    ['sec_ingestion_freshness', 'ingestion', secIngestionFreshness, true],
    ['refresh_workflow', 'publication', refreshWorkflowFreshness, true],
    ['public_manifest', 'publication', publicManifestFreshness, true],
    ['verified_population_integrity', 'publication', verifiedPopulationIntegrity, true],
    ['source_url_quality', 'publication', sourceUrlQuality, true],
    ['secondary_ingestion_health', 'ingestion', secondaryIngestionHealth, false],
    ['review_queue_health', 'quality', reviewQueueHealth, false],
    ['dedup_health', 'quality', duplicateHealth, false],
    ['ingestion_velocity', 'coverage', ingestionVelocity, false],
    ['source_diversity', 'coverage', sourceDiversity, false],
    ['filing_coverage', 'coverage', filingCoverage, false],
    ['confidence_distribution', 'coverage', confidenceDistribution, false],
  ];
}

async function persist(items, score) {
  for (const check of items) {
    await q(`INSERT INTO pie_checks(check_name,category,status,score,message,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [check.name, check.category, check.status, check.score, check.message, JSON.stringify({ ...check.detail, hard: check.hard })]);
  }

  const active = items.filter(check => check.status === 'warn' || check.status === 'fail');
  for (const check of active) {
    await q(`
      INSERT INTO pie_alerts(alert_key,severity,title,description,check_name)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(alert_key) DO UPDATE SET
        severity=EXCLUDED.severity,title=EXCLUDED.title,description=EXCLUDED.description,
        check_name=EXCLUDED.check_name,last_seen=NOW(),resolved_at=NULL
    `, [`check:${check.name}`, check.hard ? 'critical' : 'warning', check.name.replace(/_/g, ' '), check.message, check.name]);
  }

  const keys = active.map(check => `check:${check.name}`);
  if (keys.length) await q('UPDATE pie_alerts SET resolved_at=NOW() WHERE resolved_at IS NULL AND NOT(alert_key=ANY($1::text[]))', [keys]);
  else await q('UPDATE pie_alerts SET resolved_at=NOW() WHERE resolved_at IS NULL');

  const counts = items.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  await q(`INSERT INTO pie_health_snapshots(overall_score,pass_count,warn_count,fail_count,active_alerts,snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [score, counts.pass || 0, counts.warn || 0, counts.fail || 0, active.length, JSON.stringify({ checks: items })]);
  return active;
}

async function publish(payload) {
  if (!GH_TOKEN) throw new Error('MAWIRE_TOKEN/GITHUB_TOKEN is required to publish PIE health');
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/pie-health.json`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'mergers.news-pie',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const current = await fetch(`${api}?ref=main`, { headers, signal: AbortSignal.timeout(20000) });
  let sha = null;
  if (current.ok) sha = (await current.json()).sha;
  else if (current.status !== 404) throw new Error(`Health metadata read failed ${current.status}: ${await current.text()}`);

  const body = {
    message: `pie: health snapshot ${payload.generatedAt.slice(0, 16)}Z`,
    content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const response = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Health publish failed ${response.status}: ${await response.text()}`);
}

async function run() {
  const output = [];
  let canPersist = false;
  try {
    try {
      await q('SELECT 1');
      canPersist = true;
      await ensureSchema();
    } catch (error) {
      output.push(fail('database_connectivity', 'infrastructure', `Database unavailable: ${error.message}`, { error: true }));
    }

    if (canPersist) {
      for (const [name, category, fn, hard] of checkDefinitions()) {
        if (name === 'database_connectivity') {
          try { output.push(await fn()); } catch (error) { output.push(fail(name, category, `Check error: ${error.message}`, { error: true })); }
          continue;
        }
        try {
          output.push(await fn());
        } catch (error) {
          output.push(result(name, category, hard ? 'fail' : 'warn', hard ? 0 : 40, `Check error: ${error.message}`, { error: true }, hard));
        }
      }
    }

    const score = output.length ? Math.round(output.reduce((sum, check) => sum + check.score, 0) / output.length) : 0;
    const hardFailures = output.filter(check => check.hard && check.status === 'fail');
    const warnings = output.filter(check => check.status === 'warn');
    const status = hardFailures.length ? 'critical' : warnings.length ? 'degraded' : 'healthy';
    let alerts = output.filter(check => check.status !== 'pass');

    if (canPersist) {
      alerts = await persist(output, score);
      await cleanupHistory();
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      overallScore: score,
      status,
      hardFailureCount: hardFailures.length,
      warningCount: warnings.length,
      checks: output.map(({ name, category, status: checkStatus, score: checkScore, message, hard }) => ({ name, category, status: checkStatus, score: checkScore, message, hard })),
      alerts: alerts.map(check => ({ key: `check:${check.name}`, severity: check.hard ? 'critical' : 'warning', title: check.name.replace(/_/g, ' '), description: check.message })),
    };

    await publish(payload);
    console.log(`[PIE] ${score}/100 ${status} · ${hardFailures.length} hard failure(s) · ${warnings.length} warning(s)`);
    if (hardFailures.length) throw new Error(`PIE hard health gate failed: ${hardFailures.map(check => check.name).join(', ')}`);
    return payload;
  } finally {
    await db.end().catch(() => {});
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = {
  run,
  result,
  checkDefinitions,
  verifiedPopulationIntegrity,
  sourceUrlQuality,
  duplicateHealth,
};
