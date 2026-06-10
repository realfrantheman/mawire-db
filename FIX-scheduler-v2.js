'use strict';

process.on('uncaughtException',  function(err) { console.error('[FATAL] Uncaught exception:', err); });
process.on('unhandledRejection', function(err) { console.error('[FATAL] Unhandled rejection:', err); });
process.stdin.resume(); // keep process alive

console.log('[SCHEDULER] Booting...');

const cron = require('node-cron');
const { Pool } = require('pg');

console.log('[SCHEDULER] Modules loaded.');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let secRunning    = false;
let gdeltRunning  = false;
let dedupRunning  = false;
let extractRunning = false;
let newsRunning   = false;
let euRunning     = false;
let apacRunning   = false;
let pieRunning    = false;

function safeRun(name, flagRef, flagKey, fn) {
  return async () => {
    if (flagRef[flagKey]) { console.log(`[CRON] ${name} already running, skipping`); return; }
    flagRef[flagKey] = true;
    try {
      console.log(`[CRON] Starting ${name} at`, new Date().toISOString());
      const mod = require(fn);
      await mod.run();
      console.log(`[CRON] ${name} complete at`, new Date().toISOString());
    } catch (err) {
      console.error(`[CRON] ${name} error:`, err.message);
    } finally {
      flagRef[flagKey] = false;
    }
  };
}

const flags = {
  sec: false, gdelt: false, dedup: false, extract: false,
  news: false, eu: false, apac: false, pie: false,
};

// ── SEC EDGAR — every 30 minutes ──────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  if (flags.sec) { console.log('[CRON] SEC already running, skipping'); return; }
  flags.sec = true;
  try {
    console.log('[CRON] Starting SEC ingestor');
    const { run } = require('./services/sec-ingestor/index');
    await run();
  } catch (err) {
    console.error('[CRON] SEC error:', err.message);
  } finally {
    flags.sec = false;
  }
});

// ── GDELT — every hour ────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  if (flags.gdelt) { console.log('[CRON] GDELT already running, skipping'); return; }
  flags.gdelt = true;
  try {
    console.log('[CRON] Starting GDELT ingestor');
    const { run } = require('./services/gdelt-ingestor/index');
    await run();
  } catch (err) {
    console.error('[CRON] GDELT error:', err.message);
  } finally {
    flags.gdelt = false;
  }
});

// ── NEWS RSS — every 2 hours ───────────────────────────────────────
cron.schedule('0 */2 * * *', async () => {
  if (flags.news) { console.log('[CRON] News already running, skipping'); return; }
  flags.news = true;
  try {
    console.log('[CRON] Starting News RSS ingestor');
    const { run } = require('./services/news-ingestor/index');
    await run();
  } catch (err) {
    console.error('[CRON] News error:', err.message);
  } finally {
    flags.news = false;
  }
});

// ── EU MERGER REGISTRY — every 12 hours ───────────────────────────
cron.schedule('0 */12 * * *', async () => {
  if (flags.eu) { console.log('[CRON] EU already running, skipping'); return; }
  flags.eu = true;
  try {
    console.log('[CRON] Starting EU ingestor');
    const { run } = require('./services/eu-ingestor/index');
    await run();
  } catch (err) {
    console.error('[CRON] EU error:', err.message);
  } finally {
    flags.eu = false;
  }
});

// ── APAC (HKEX + ASX + SGX) — every 4 hours ──────────────────────
cron.schedule('0 */4 * * *', async () => {
  if (flags.apac) { console.log('[CRON] APAC already running, skipping'); return; }
  flags.apac = true;
  try {
    console.log('[CRON] Starting APAC ingestor');
    const { run } = require('./services/apac-ingestor/index');
    await run();
  } catch (err) {
    console.error('[CRON] APAC error:', err.message);
  } finally {
    flags.apac = false;
  }
});

// ── EXTRACTION QUEUE — every 5 minutes ────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  if (flags.extract) return;
  flags.extract = true;
  try {
    const pending = await db.query(`
      SELECT d.id, d.headline, f.filing_type, f.edgar_url, f.accession_no, f.cik, ds.raw_content
      FROM deals d
      LEFT JOIN filings f       ON f.deal_id   = d.id
      LEFT JOIN deal_sources ds ON ds.deal_id  = d.id AND ds.source_type = 'sec_edgar'
      WHERE d.needs_review = true AND d.source_confidence < 0.85
      LIMIT 20
    `);
    if (!pending.rows.length) { flags.extract = false; return; }

    const extractor = require('./services/ai-extraction/extractor');
    for (const deal of pending.rows) {
      try {
        const extracted = extractor.extractDealInfo(
          (deal.raw_content || '').slice(0, 10000),
          deal.filing_type,
          deal.headline
        );
        if (!extracted) { await db.query('UPDATE deals SET needs_review=false WHERE id=$1', [deal.id]); continue; }
        await db.query(`
          UPDATE deals SET
            headline          = COALESCE($1, headline),
            deal_value        = COALESCE($2, deal_value),
            per_share_value   = COALESCE($3, per_share_value),
            premium_pct       = COALESCE($4, premium_pct),
            announcement_date = COALESCE($5, announcement_date),
            sector            = COALESCE($6, sector),
            source_confidence = GREATEST(source_confidence, $7),
            needs_review      = false,
            updated_at        = NOW()
          WHERE id = $8
        `, [
          extracted.headline, extracted.deal_value_usd ? Math.round(extracted.deal_value_usd * 100) : null,
          extracted.per_share_value, extracted.premium_pct, extracted.announcement_date,
          extracted.sector, Math.min(0.95, extracted.confidence || 0.5), deal.id,
        ]);
        console.log(`[EXTRACT] Processed: ${extracted.headline || deal.headline}`);
      } catch (err) {
        console.error(`[EXTRACT] Error on deal ${deal.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[CRON] Extract error:', err.message);
  } finally {
    flags.extract = false;
  }
});

// ── DEDUPLICATION — every 6 hours ─────────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  if (flags.dedup) return;
  flags.dedup = true;
  try {
    console.log('[CRON] Starting deduplication');
    const dedup = require('./services/deduplication/index');
    await dedup.run();
  } catch (err) {
    console.error('[CRON] Dedup error:', err.message);
  } finally {
    flags.dedup = false;
  }
});

// ── EXPORT TO GITHUB — every 2 hours ──────────────────────────────
cron.schedule('30 */2 * * *', async () => {
  try {
    console.log('[CRON] Starting GitHub export');
    const exporter = require('./scripts/export-to-github');
    await exporter.run();
    console.log('[CRON] GitHub export complete');
  } catch (err) {
    console.error('[CRON] GitHub export error:', err.message);
  }
});

// ── PLATFORM INTEGRITY ENGINE — every hour ────────────────────────
cron.schedule('45 * * * *', async () => {
  if (flags.pie) { console.log('[CRON] PIE already running, skipping'); return; }
  flags.pie = true;
  try {
    console.log('[CRON] Starting PIE monitor');
    const { run } = require('./services/pie-monitor/index');
    await run();
    console.log('[CRON] PIE monitor complete');
  } catch (err) {
    console.error('[CRON] PIE error:', err.message);
  } finally {
    flags.pie = false;
  }
});

// ── STATS CACHE — every hour ───────────────────────────────────────
cron.schedule('15 * * * *', async () => {
  try {
    await db.query(`DELETE FROM stats_cache WHERE key = 'api_stats'`);
    console.log('[CRON] Stats cache invalidated');
  } catch (err) {
    console.error('[CRON] Stats cache error:', err.message);
  }
});

// ── STARTUP ────────────────────────────────────────────────────────
console.log('[SCHEDULER] ==========================================');
console.log('[SCHEDULER] mergers.news Pipeline Scheduler v2');
console.log('[SCHEDULER]   SEC EDGAR       every 30 min');
console.log('[SCHEDULER]   GDELT           every 1 hour');
console.log('[SCHEDULER]   News RSS        every 2 hours');
console.log('[SCHEDULER]   EU Merger Reg   every 12 hours');
console.log('[SCHEDULER]   APAC (HK/AU/SG) every 4 hours');
console.log('[SCHEDULER]   Extraction      every 5 min');
console.log('[SCHEDULER]   Dedup           every 6 hours');
console.log('[SCHEDULER]   Stats cache     every 1 hour');
console.log('[SCHEDULER]   PIE monitor     every 1 hour');
console.log('[SCHEDULER] ==========================================');
console.log('[SCHEDULER] All crons active. Waiting for first tick...');

// Staggered startup runs
setTimeout(async () => {
  try { const { run } = require('./services/sec-ingestor/index'); await run(); }
  catch (err) { console.error('[STARTUP] SEC failed:', err.message); }
}, 2000);

setTimeout(async () => {
  try { const { run } = require('./services/news-ingestor/index'); await run(); }
  catch (err) { console.error('[STARTUP] News failed:', err.message); }
}, 15000);

setTimeout(async () => {
  try { const { run } = require('./services/eu-ingestor/index'); await run(); }
  catch (err) { console.error('[STARTUP] EU failed:', err.message); }
}, 30000);

setTimeout(async () => {
  try { const { run } = require('./services/apac-ingestor/index'); await run(); }
  catch (err) { console.error('[STARTUP] APAC failed:', err.message); }
}, 45000);

setTimeout(async () => {
  try {
    console.log('[STARTUP] Running GitHub export...');
    const exporter = require('./scripts/export-to-github');
    await exporter.run();
  } catch (err) { console.error('[STARTUP] GitHub export failed:', err.message); }
}, 60000);
