'use strict';

console.log('[SCHEDULER] Booting...');

const cron = require('node-cron');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL is required');
  process.exit(1);
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true },
  max: 8,
  statement_timeout: 120000,
});

db.on('error', error => console.error('[SCHEDULER] idle database client error:', error.message));

let shuttingDown = false;
function fatal(kind, error) {
  console.error(`[FATAL] ${kind}:`, error?.stack || error);
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
}
process.on('uncaughtException', error => fatal('Uncaught exception', error));
process.on('unhandledRejection', error => fatal('Unhandled rejection', error));

async function withAdvisoryLock(name, fn) {
  const client = await db.connect();
  const key = `mawire:scheduler:${name}`;
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    locked = result.rows[0]?.locked === true;
    if (!locked) {
      console.log(`[CRON] ${name} already active in another scheduler; skipping`);
      return false;
    }
    await fn();
    return true;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(error => {
        console.error(`[CRON] ${name} unlock failed:`, error.message);
      });
    }
    client.release();
  }
}

function moduleTask(name, modulePath) {
  return async () => withAdvisoryLock(name, async () => {
    const started = Date.now();
    console.log(`[CRON] Starting ${name} at ${new Date().toISOString()}`);
    try {
      const mod = require(modulePath);
      if (!mod || typeof mod.run !== 'function') throw new Error(`${modulePath} does not export run()`);
      await mod.run();
      console.log(`[CRON] ${name} complete in ${Date.now() - started}ms`);
    } catch (error) {
      console.error(`[CRON] ${name} failed:`, error.stack || error.message);
      throw error;
    }
  }).catch(error => {
    // A source failure must not kill unrelated schedules; ingestion_log/PIE records health.
    console.error(`[CRON] ${name} isolated failure:`, error.message);
  });
}

const runSec = moduleTask('sec', './services/sec-ingestor/index');
const runGdelt = moduleTask('gdelt', './services/gdelt-ingestor/index');
const runNews = moduleTask('news', './services/news-ingestor/index');
const runEu = moduleTask('eu', './services/eu-ingestor/index');
const runApac = moduleTask('apac', './services/apac-ingestor/index');
const runDedup = moduleTask('dedup', './services/deduplication/index');

function retryDelay(attempt) {
  const minutes = Math.min(24 * 60, 5 * (2 ** Math.max(0, attempt - 1)));
  return `${minutes} minutes`;
}

async function markReviewFailure(id, message) {
  const current = await db.query('SELECT COALESCE(review_attempts,0) AS attempts FROM deals WHERE id=$1', [id]);
  const nextAttempt = Number(current.rows[0]?.attempts || 0) + 1;
  const terminal = nextAttempt >= 5;
  await db.query(`
    UPDATE deals
    SET review_attempts = COALESCE(review_attempts,0) + 1,
        review_last_attempt_at = NOW(),
        review_last_error = LEFT($2, 1000),
        review_status = CASE WHEN COALESCE(review_attempts,0) + 1 >= 5 THEN 'deferred' ELSE 'retry' END,
        next_review_at = CASE WHEN COALESCE(review_attempts,0) + 1 >= 5 THEN NOW() + INTERVAL '30 days' ELSE NOW() + $3::interval END,
        updated_at = NOW()
    WHERE id = $1
  `, [id, message, retryDelay(nextAttempt)]);
  console.warn(`[EXTRACT] ${id} ${terminal ? 'deferred' : 'queued for retry'} after attempt ${nextAttempt}: ${message}`);
}

async function runExtractionQueue() {
  return withAdvisoryLock('extraction', async () => {
    const pending = await db.query(`
      SELECT d.id,d.headline,d.acquirer_id,d.target_id,d.source_confidence,d.review_attempts,
             f.filing_type,f.edgar_url,f.accession_no,f.cik,ds.raw_content
      FROM deals d
      LEFT JOIN LATERAL (
        SELECT filing_type,edgar_url,accession_no,cik
        FROM filings
        WHERE deal_id=d.id
        ORDER BY filing_date DESC NULLS LAST,created_at DESC,id
        LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT raw_content
        FROM deal_sources
        WHERE deal_id=d.id AND source_type='sec_edgar'
        ORDER BY confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id
        LIMIT 1
      ) ds ON true
      WHERE d.canonical_id IS NULL
        AND d.needs_review=true
        AND COALESCE(d.review_status,'pending') IN ('pending','retry')
        AND (d.next_review_at IS NULL OR d.next_review_at<=NOW())
      ORDER BY COALESCE(d.review_priority,0) DESC,
               d.source_confidence DESC NULLS LAST,
               d.announcement_date DESC NULLS LAST,
               d.created_at DESC,
               d.id
      LIMIT 20
    `);

    if (!pending.rows.length) return;
    const extractor = require('./services/ai-extraction/extractor');

    for (const deal of pending.rows) {
      try {
        const evidence = String(deal.raw_content || '').slice(0, 10000);
        if (!evidence.trim()) {
          await markReviewFailure(deal.id, 'No SEC source evidence available for extraction');
          continue;
        }

        const extracted = extractor.extractDealInfo(evidence, deal.filing_type, deal.headline);
        if (!extracted) {
          await markReviewFailure(deal.id, 'Extractor returned no transaction result');
          continue;
        }

        const confidence = Math.min(0.95, Number(extracted.confidence || 0.5));
        const partiesResolved = !!deal.acquirer_id && !!deal.target_id;
        const canResolve = partiesResolved && confidence >= 0.75;
        await db.query(`
          UPDATE deals SET
            headline = COALESCE($1,headline),
            deal_value = COALESCE($2,deal_value),
            per_share_value = COALESCE($3,per_share_value),
            premium_pct = COALESCE($4,premium_pct),
            announcement_date = COALESCE($5,announcement_date),
            sector = COALESCE($6,sector),
            source_confidence = GREATEST(source_confidence,$7),
            needs_review = CASE WHEN $8 THEN false ELSE true END,
            review_status = CASE WHEN $8 THEN 'resolved' ELSE 'deferred' END,
            review_attempts = 0,
            review_last_attempt_at = NOW(),
            review_last_error = NULL,
            next_review_at = CASE WHEN $8 THEN NULL ELSE NOW()+INTERVAL '30 days' END,
            updated_at = NOW()
          WHERE id=$9
        `, [
          extracted.headline || null,
          extracted.deal_value_usd ? Math.round(Number(extracted.deal_value_usd) * 100) : null,
          extracted.per_share_value || null,
          extracted.premium_pct ?? null,
          extracted.announcement_date || null,
          extracted.sector || null,
          confidence,
          canResolve,
          deal.id,
        ]);
        console.log(`[EXTRACT] ${canResolve ? 'resolved' : 'enriched/deferred'} ${deal.id}: ${extracted.headline || deal.headline}`);
      } catch (error) {
        await markReviewFailure(deal.id, error.message).catch(markError => {
          console.error(`[EXTRACT] Could not persist failure for ${deal.id}:`, markError.message);
        });
      }
    }
  }).catch(error => console.error('[CRON] Extraction queue failed:', error.stack || error.message));
}

async function invalidateStats() {
  return withAdvisoryLock('stats-cache', async () => {
    await db.query("DELETE FROM stats_cache WHERE key='api_stats' OR key LIKE 'api_stats:%'");
    console.log('[CRON] Stats cache invalidated');
  }).catch(error => console.error('[CRON] Stats cache error:', error.message));
}

async function heartbeat() {
  try {
    await db.query(`
      INSERT INTO stats_cache(key,value,computed_at,expires_at)
      VALUES('scheduler_heartbeat',$1::jsonb,NOW(),NOW()+INTERVAL '5 minutes')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,computed_at=NOW(),expires_at=EXCLUDED.expires_at
    `, [JSON.stringify({ pid: process.pid, at: new Date().toISOString() })]);
  } catch (error) {
    console.error('[SCHEDULER] heartbeat failed:', error.message);
  }
}

cron.schedule('*/30 * * * *', runSec);
cron.schedule('0 * * * *', runGdelt);
cron.schedule('0 */2 * * *', runNews);
cron.schedule('0 */12 * * *', runEu);
cron.schedule('0 */4 * * *', runApac);
cron.schedule('*/5 * * * *', runExtractionQueue);
cron.schedule('0 */6 * * *', runDedup);
cron.schedule('15 * * * *', invalidateStats);
cron.schedule('* * * * *', heartbeat);

console.log('[SCHEDULER] ==========================================');
console.log('[SCHEDULER] mergers.news Pipeline Scheduler v3');
console.log('[SCHEDULER]   SEC EDGAR       every 30 min');
console.log('[SCHEDULER]   GDELT           every 1 hour');
console.log('[SCHEDULER]   News RSS        every 2 hours');
console.log('[SCHEDULER]   EU Merger Reg   every 12 hours');
console.log('[SCHEDULER]   APAC (HK/AU/SG) every 4 hours');
console.log('[SCHEDULER]   Extraction      every 5 min');
console.log('[SCHEDULER]   Dedup           every 6 hours');
console.log('[SCHEDULER] Public artifacts are owned by refresh-deals.yml only.');
console.log('[SCHEDULER] ==========================================');

// Startup work uses exactly the same distributed locks as cron work.
setTimeout(runSec, 2000);
setTimeout(runNews, 15000);
setTimeout(runEu, 30000);
setTimeout(runApac, 45000);
setTimeout(runGdelt, 60000);
setTimeout(heartbeat, 1000);

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SCHEDULER] ${signal} received; closing database pool`);
  try { await db.end(); } catch (error) { console.error('[SCHEDULER] shutdown error:', error.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { withAdvisoryLock, retryDelay, runExtractionQueue, heartbeat };
