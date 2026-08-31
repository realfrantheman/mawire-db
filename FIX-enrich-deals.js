/**
 * mergers.news — Deal Enrichment Script
 * Fixes existing DB records that have placeholder acquirer/target names.
 *
 * Queries deals where companies.name IN ('Disclosed in filing',
 * 'Public company target (see filing)', 'Acquirer (see filing)',
 * 'Target (see filing)', 'Unknown') then fetches + parses the
 * filing document to extract the real party name and deal value.
 *
 * Run on Railway as a one-time job:
 *   node scripts/enrich-deals.js
 *
 * Or run in batches to avoid hitting SEC rate limits:
 *   BATCH=100 node scripts/enrich-deals.js
 */

'use strict';

const https    = require('https');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true } });

const BATCH   = parseInt(process.env.BATCH || '200', 10);
const DELAY   = 700; // ms between filing fetches — SEC rate limit

const PLACEHOLDER_NAMES = [
  'Disclosed in filing',
  'Public company target (see filing)',
  'Acquirer (see filing)',
  'Target (see filing)',
  'Unknown',
  'Acquirer (see Filing)',
  'Target (see Filing)',
];

// ── HTTP FETCH (text) ─────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'mergers.news contact@mergers.news', 'Accept': 'text/html,text/plain' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        req.destroy();
        return fetchText(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', c => {
        data += c;
        if (data.length > 40000) { req.destroy(); resolve(data.slice(0, 40000)); }
      });
      res.on('end', () => resolve(data.slice(0, 40000)));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── EXTRACTION ────────────────────────────────────────────────────
function extractOtherParty(text, filingType) {
  if (!text || text.length < 100) return null;

  const pDEFM = [
    /to\s+be\s+acquired\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    /acquisition\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    /PROPOSED\s+MERGER\s+WITH\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60})/i,
    /Agreement\s+and\s+Plan\s+of\s+Merger.{0,200}(?:and\s+)([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?)?)/i,
  ];
  const pSCTOT = [
    /Offer\s+to\s+Purchase\s+(?:All\s+)?(?:Outstanding\s+)?(?:Shares|Stock)\s+of\s+(?:Common\s+Stock\s+of\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    /(?:acquire|purchase)\s+(?:all\s+)?(?:outstanding\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    /tender\s+offer\s+for\s+(?:all\s+)?(?:shares\s+of\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
  ];

  const ft = (filingType || '').toUpperCase();
  const patterns = (ft.includes('DEFM14A') || ft.includes('PREM14A') || ft.includes('DEFA14A') || ft === 'S-4')
    ? pDEFM
    : (ft.includes('SC TO-T') ? pSCTOT : [...pDEFM, ...pSCTOT]);

  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length >= 3 && name.length <= 80 && !/^(the|a|an|all|any|this|each)\b/i.test(name)) {
        return name;
      }
    }
  }
  return null;
}

function extractDealValueCents(text) {
  if (!text) return null;
  const candidates = [];
  const bpat = /(?:aggregate|total|transaction)\s+(?:consideration|value)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*billion/gi;
  const mpat = /(?:aggregate|total|transaction)\s+(?:consideration|value)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*million/gi;
  let m;
  while ((m = bpat.exec(text)) !== null) { const v = parseFloat(m[1].replace(/,/g, '')) * 1e9; if (!isNaN(v) && v >= 1e7) candidates.push(v); }
  while ((m = mpat.exec(text)) !== null) { const v = parseFloat(m[1].replace(/,/g, '')) * 1e6; if (!isNaN(v) && v >= 1e6) candidates.push(v); }
  if (!candidates.length) return null;
  return Math.round(Math.max(...candidates) * 100);
}

function normalizeName(name) {
  return String(name).toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g, '')
    .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── UPSERT COMPANY (returns id) ───────────────────────────────────
async function upsertCompany(name) {
  const normalized = normalizeName(name);
  const byName = await db.query('SELECT id FROM companies WHERE normalized_name = $1 LIMIT 1', [normalized]);
  if (byName.rows.length) return byName.rows[0].id;
  const res = await db.query(
    'INSERT INTO companies (name, normalized_name) VALUES ($1, $2) RETURNING id',
    [name.slice(0, 500), normalized.slice(0, 500)]
  );
  return res.rows[0].id;
}

// ── MAIN ──────────────────────────────────────────────────────────
async function run() {
  const placeholders = PLACEHOLDER_NAMES.map((_, i) => `$${i + 1}`).join(',');

  // Find deals where acquirer OR target is a placeholder
  const query = await db.query(`
    SELECT
      d.id           AS deal_id,
      d.deal_type,
      d.deal_value,
      a.name         AS acquirer_name,
      a.id           AS acquirer_id,
      t.name         AS target_name,
      t.id           AS target_id,
      f.filing_type,
      f.document_url,
      f.edgar_url
    FROM deals d
    LEFT JOIN companies a  ON d.acquirer_id = a.id
    LEFT JOIN companies t  ON d.target_id   = t.id
    LEFT JOIN filings   f  ON f.deal_id     = d.id
    WHERE (a.name = ANY($1) OR t.name = ANY($1))
      AND d.canonical_id IS NULL
    ORDER BY d.announcement_date DESC NULLS LAST
    LIMIT $2
  `, [PLACEHOLDER_NAMES, BATCH]);

  console.log(`[ENRICH] Found ${query.rows.length} deals with placeholder names (batch=${BATCH})`);

  let enriched = 0, skipped = 0, failed = 0;

  for (const row of query.rows) {
    try {
      const docUrl = row.document_url || row.edgar_url;
      if (!docUrl) { skipped++; continue; }

      const html    = await fetchText(docUrl);
      const text    = html ? stripHtml(html) : '';
      const ft      = row.filing_type || '';

      let updated = false;

      // Fix acquirer
      if (PLACEHOLDER_NAMES.includes(row.acquirer_name)) {
        const extracted = extractOtherParty(text, ft);
        if (extracted) {
          const newId = await upsertCompany(extracted);
          await db.query('UPDATE deals SET acquirer_id = $1, needs_review = false WHERE id = $2', [newId, row.deal_id]);
          console.log(`[ENRICH] Deal ${row.deal_id}: acquirer "${row.acquirer_name}" → "${extracted}"`);
          updated = true;
        }
      }

      // Fix target
      if (PLACEHOLDER_NAMES.includes(row.target_name)) {
        const extracted = extractOtherParty(text, ft);
        if (extracted) {
          const newId = await upsertCompany(extracted);
          await db.query('UPDATE deals SET target_id = $1, needs_review = false WHERE id = $2', [newId, row.deal_id]);
          console.log(`[ENRICH] Deal ${row.deal_id}: target "${row.target_name}" → "${extracted}"`);
          updated = true;
        }
      }

      // Backfill deal value if missing
      if (!row.deal_value && text) {
        const cents = extractDealValueCents(text);
        if (cents) {
          await db.query('UPDATE deals SET deal_value = $1 WHERE id = $2', [cents, row.deal_id]);
          console.log(`[ENRICH] Deal ${row.deal_id}: deal_value → ${cents / 100}`);
          updated = true;
        }
      }

      if (updated) enriched++; else skipped++;

      await sleep(DELAY);
    } catch (err) {
      failed++;
      console.error(`[ENRICH] Deal ${row.deal_id} error:`, err.message);
    }
  }

  console.log(`\n[ENRICH] Done: ${enriched} enriched, ${skipped} skipped, ${failed} failed`);
  console.log('[ENRICH] Run again to process next batch, or increase BATCH= env var.');
  await db.end();
}

run().catch(err => { console.error('[ENRICH] Fatal:', err); db.end(); process.exit(1); });
