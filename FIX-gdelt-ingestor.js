/**
 * mergers.news — GDELT News Ingestion Service
 * GDELT is 100% free — global news events database updated every 15 minutes
 * Docs: https://www.gdeltproject.org/data.html
 *
 * Strategy:
 * 1. Fetch GDELT GKG (Global Knowledge Graph) latest file
 * 2. Filter for M&A-related themes
 * 3. Cross-reference with SEC deals for enrichment
 * 4. Store new deal signals not yet in SEC data
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const zlib     = require('zlib');
const { Pool } = require('pg');
const extractor = require('../ai-extraction/extractor');
const sharedExtractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { rawSnippet, withRetry } = require(sharedExtractionPath);

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true } });

// GDELT GKG 2.0 fields we care about
const GKG_FIELDS = {
  DATE:        0,
  SOURCEURL:   4,
  THEMES:      7,
  PERSONS:     11,
  ORGS:        12,
  TONE:        15,
  AMOUNTS:     16,
};

// M&A related GDELT themes
const MA_THEMES = [
  'ECON_MERGER', 'ECON_ACQUISITION', 'ECON_BUYOUT',
  'ECON_INVEST', 'BUS_FINANCE', 'ECON_DEAL',
  'MANMADE_DISASTER_FINANCIAL', // hostile takeovers often tagged here
];

// Keywords to filter headlines
const MA_KEYWORDS = [
  'acquires', 'acquisition', 'merger', 'buyout', 'takeover',
  'tender offer', 'going private', 'buys', 'purchased',
  'deal worth', 'valued at', 'billion deal', 'million deal',
];

// ── MAIN ──────────────────────────────────────────────────────────
async function run() {
  console.log('[GDELT] Starting ingestion run at', new Date().toISOString());

  let fetched = 0, new_ = 0, failed = 0;

  try {
    // Get latest GDELT GKG file URL
    const latestUrl = await getLatestGKGUrl();
    if (!latestUrl) {
      console.warn('[GDELT] Could not get latest GKG URL');
      return;
    }

    console.log('[GDELT] Fetching:', latestUrl);

    // Fetch and parse GKG CSV
    const records = await fetchAndParseGKG(latestUrl);
    fetched = records.length;
    console.log(`[GDELT] Parsed ${fetched} records`);

    // Filter for M&A records
    const maRecords = records.filter(isMARecord);
    console.log(`[GDELT] M&A records: ${maRecords.length}`);

    // Process each record
    for (const record of maRecords) {
      try {
        const result = await processGDELTRecord(record);
        if (result === 'new') new_++;
      } catch (err) {
        failed++;
        console.error('[GDELT] Record error:', err.message);
      }
    }

    console.log(`[GDELT] Done — fetched: ${fetched}, new: ${new_}, failed: ${failed}`);
  } catch (err) {
    console.error('[GDELT] Fatal:', err.message);
  } finally {
    await db.end();
  }
}

// ── GET LATEST GKG FILE ───────────────────────────────────────────
async function getLatestGKGUrl() {
  // GDELT updates every 15 minutes
  // The master file list tells us what's available
  const masterUrl = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

  const text = await withRetry(() => fetchPlainText(masterUrl), { attempts: 4, baseDelayMs: 1000 });
  if (!text) return null;

  // Format: "hash size http://data.gdeltproject.org/gdeltv2/YYYYMMDDHHMMSS.gkg.csv.zip"
  const lines = text.trim().split('\n');
  const gkgLine = lines.find(l => l.includes('.gkg.csv.zip'));
  if (!gkgLine) return null;

  const parts = gkgLine.trim().split(' ');
  return parts[parts.length - 1]; // URL is last field
}

// ── FETCH AND PARSE GKG CSV ───────────────────────────────────────
async function fetchAndParseGKG(url) {
  return new Promise((resolve, reject) => {
    const records = [];

    const req = (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': 'mergers.news contact@mergers.news' }
    }, res => {
      const gunzip = zlib.createGunzip();
      const stream = res.pipe(gunzip);

      let buffer = '';
      stream.on('data', chunk => {
        buffer += chunk.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const record = parseGKGLine(line);
            if (record) records.push(record);
          } catch { /* skip malformed */ }
        }
      });

      stream.on('end', () => {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const record = parseGKGLine(buffer);
            if (record) records.push(record);
          } catch { /* skip */ }
        }
        resolve(records);
      });

      stream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('GDELT timeout')); });
  });
}

// ── PARSE SINGLE GKG LINE ─────────────────────────────────────────
function parseGKGLine(line) {
  const fields = line.split('\t');
  if (fields.length < 17) return null;

  const date      = fields[GKG_FIELDS.DATE];
  const sourceUrl = fields[GKG_FIELDS.SOURCEURL];
  const themes    = fields[GKG_FIELDS.THEMES] || '';
  const orgs      = fields[GKG_FIELDS.ORGS]   || '';
  const amounts   = fields[GKG_FIELDS.AMOUNTS] || '';

  if (!sourceUrl || !date) return null;

  return { date, sourceUrl, themes, orgs, amounts, raw: line.slice(0, 500) };
}

// ── IS M&A RECORD ─────────────────────────────────────────────────
function isMARecord(record) {
  const text = (record.themes + ' ' + record.sourceUrl).toLowerCase();

  // Check GDELT themes
  const hasMATheme = MA_THEMES.some(t => record.themes.includes(t));
  if (hasMATheme) return true;

  // Check URL for M&A keywords
  const hasKeyword = MA_KEYWORDS.some(k => text.includes(k));
  return hasKeyword;
}

// ── PROCESS GDELT RECORD ──────────────────────────────────────────
async function processGDELTRecord(record) {
  // Check if URL already processed
  const existing = await db.query(
    `SELECT source_url FROM deal_sources WHERE source_url = $1
     UNION ALL
     SELECT source_url FROM ingestion_raw_sources WHERE source_url = $1
     LIMIT 1`,
    [record.sourceUrl]
  );
  if (existing.rows.length) return 'skip';

  // Fetch article text
  const articleText = await fetchArticleText(record.sourceUrl);

  // Extract deal info using free extractor
  const extracted = articleText
    ? extractor.extractDealInfo(articleText, null, null)
    : null;

  if (!extracted || (!extracted.acquirer && !extracted.target)) {
    // Store source URL to avoid re-processing
    await db.query(
      `INSERT INTO ingestion_raw_sources (source_type, source_url, source_date, raw_content, processing_status)
       VALUES ('gdelt', $1, $2, $3, 'needs_review')
       ON CONFLICT (source_url) DO UPDATE SET raw_content = EXCLUDED.raw_content, updated_at = NOW()`,
      [record.sourceUrl, parseGDELTDate(record.date), record.raw]
    );
    return 'no_deal';
  }

  // Try to match with existing deal in database
  const matchedDealId = await findMatchingDeal(extracted);

  if (matchedDealId) {
    // Enrich existing deal with news source
    await db.query(`
      INSERT INTO deal_sources (deal_id, source_type, source_name, source_url, source_date, raw_content)
      VALUES ($1, 'gdelt', 'GDELT News', $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [matchedDealId, record.sourceUrl, parseGDELTDate(record.date), articleText?.slice(0, 500)]);

    // Boost confidence of matched deal
    await db.query(
      `UPDATE deals SET source_confidence = LEAST(0.95, source_confidence + 0.05), updated_at = NOW() WHERE id = $1`,
      [matchedDealId]
    );
    return 'enriched';
  }

  // Create new deal from GDELT signal
  if (extracted.acquirer || extracted.target) {
    await createDealFromGDELT(extracted, record);
    return 'new';
  }

  return 'skip';
}

// ── CREATE DEAL FROM GDELT ────────────────────────────────────────
async function createDealFromGDELT(extracted, record) {
  // Upsert companies
  let acquirerId = null, targetId = null;

  if (extracted.acquirer) {
    const res = await db.query(
      `INSERT INTO companies (name, normalized_name) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`,
      [extracted.acquirer, normalizeName(extracted.acquirer)]
    );
    acquirerId = res.rows[0]?.id;
    if (!acquirerId) {
      const found = await db.query('SELECT id FROM companies WHERE normalized_name = $1', [normalizeName(extracted.acquirer)]);
      acquirerId = found.rows[0]?.id;
    }
  }

  if (extracted.target) {
    const res = await db.query(
      `INSERT INTO companies (name, normalized_name) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`,
      [extracted.target, normalizeName(extracted.target)]
    );
    targetId = res.rows[0]?.id;
    if (!targetId) {
      const found = await db.query('SELECT id FROM companies WHERE normalized_name = $1', [normalizeName(extracted.target)]);
      targetId = found.rows[0]?.id;
    }
  }

  const dealRes = await db.query(`
    INSERT INTO deals (
      acquirer_id, target_id, headline, deal_type, status,
      deal_value, per_share_value, premium_pct,
      announcement_date, sector, source_confidence,
      extraction_method, needs_review, extracted_acquirer_name,
      extracted_target_name, raw_extracted_snippet
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'gdelt_news',$12,$13,$14,$15)
    RETURNING id
  `, [
    acquirerId, targetId,
    extracted.headline || `${extracted.acquirer || '?'} / ${extracted.target || '?'}`,
    extracted.deal_type || 'Merger',
    'Announced',
    extracted.deal_value_usd ? Math.round(extracted.deal_value_usd * 100) : null,
    extracted.per_share_value,
    extracted.premium_pct,
    extracted.announcement_date || parseGDELTDate(record.date),
    extracted.sector,
    Math.min(0.6, extracted.confidence || 0.3), // lower confidence for news-only deals
    !acquirerId || !targetId,
    extracted.acquirer || null,
    extracted.target || null,
    rawSnippet(record.raw),
  ]);

  await db.query(`
    INSERT INTO deal_sources (deal_id, source_type, source_name, source_url, source_date, raw_content, confidence)
    VALUES ($1, 'gdelt', 'GDELT News', $2, $3, $4, $5)
  `, [dealRes.rows[0].id, record.sourceUrl, parseGDELTDate(record.date), rawSnippet(record.raw), Math.min(0.6, extracted.confidence || 0.3)]);
}

// ── FIND MATCHING DEAL ────────────────────────────────────────────
async function findMatchingDeal(extracted) {
  if (!extracted.acquirer && !extracted.target) return null;

  const acquirerNorm = extracted.acquirer ? normalizeName(extracted.acquirer) : null;
  const targetNorm   = extracted.target   ? normalizeName(extracted.target)   : null;

  const res = await db.query(`
    SELECT d.id
    FROM deals d
    LEFT JOIN companies a ON d.acquirer_id = a.id
    LEFT JOIN companies t ON d.target_id   = t.id
    WHERE
      (a.normalized_name = $1 OR t.normalized_name = $2)
      AND ($3::date IS NULL OR ABS(d.announcement_date - $3::date) < 180)
    LIMIT 1
  `, [acquirerNorm, targetNorm, extracted.announcement_date || null]);

  return res.rows[0]?.id || null;
}

// ── HELPERS ────────────────────────────────────────────────────────
function parseGDELTDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return null;
  const yr = dateStr.slice(0, 4);
  const mo = dateStr.slice(4, 6);
  const dy = dateStr.slice(6, 8);
  return `${yr}-${mo}-${dy}`;
}

function normalizeName(name) {
  return String(name).toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g, '')
    .trim();
}

async function fetchPlainText(url) {
  return new Promise(resolve => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'mergers.news' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data || null));
    }).on('error', () => resolve(null));
  });
}

async function fetchArticleText(url) {
  try {
    const text = await fetchPlainText(url);
    if (!text) return null;
    // Strip HTML
    return text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  } catch { return null; }
}

module.exports = { run };

if (require.main === module) {
  run().catch(console.error);
}
