'use strict';

const cron = require('node-cron');

const secIngestor  = require('./services/sec-ingestor/index.js');
const newsIngestor = require('./services/news-ingestor/index.js');
const euIngestor   = require('./services/eu-ingestor/index.js');
const apacIngestor = require('./services/apac-ingestor/index.js');

function safeName(name) {
  return `[SCHEDULER/${name.toUpperCase()}]`;
}

function wrapRun(name, runFn) {
  return async () => {
    const tag = safeName(name);
    console.log(`${tag} Starting scheduled run at`, new Date().toISOString());
    try {
      await runFn();
      console.log(`${tag} Completed at`, new Date().toISOString());
    } catch (err) {
      console.error(`${tag} Uncaught error:`, err.message || err);
    }
  };
}

function startScheduler() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║         mergers.news — Ingestion Scheduler v2        ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  SEC EDGAR       every 30 min   (0,30 * * * *)       ║');
  console.log('║  News RSS        every 2 hours  (0 */2 * * *)        ║');
  console.log('║  EU Merger Reg   every 12 hours (0 */12 * * *)       ║');
  console.log('║  APAC (HK/AU/SG) every 4 hours  (0 */4 * * *)        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // ── SEC EDGAR — every 30 minutes ────────────────────────────────────────
  cron.schedule('0,30 * * * *', wrapRun('SEC', secIngestor.run), {
    scheduled: true,
    timezone:  'UTC',
  });

  // ── News RSS — every 2 hours ─────────────────────────────────────────────
  cron.schedule('0 */2 * * *', wrapRun('NEWS', newsIngestor.run), {
    scheduled: true,
    timezone:  'UTC',
  });

  // ── EU Merger Registry — every 12 hours ──────────────────────────────────
  cron.schedule('0 */12 * * *', wrapRun('EU', euIngestor.run), {
    scheduled: true,
    timezone:  'UTC',
  });

  // ── APAC (HKEX + ASX + SGX) — every 4 hours ──────────────────────────────
  cron.schedule('0 */4 * * *', wrapRun('APAC', apacIngestor.run), {
    scheduled: true,
    timezone:  'UTC',
  });

  console.log('[SCHEDULER] All crons registered. Starting startup runs...');

  // ── Startup runs ─────────────────────────────────────────────────────────
  // SEC runs immediately
  setTimeout(() => {
    wrapRun('SEC', secIngestor.run)();
  }, 0);

  // News RSS runs 10 seconds after SEC starts (stagger startup)
  setTimeout(() => {
    wrapRun('NEWS', newsIngestor.run)();
  }, 10000);
}

startScheduler();
