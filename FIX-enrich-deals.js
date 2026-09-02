/**
 * mergers.news — deterministic deal enrichment
 *
 * Repairs placeholder party names and missing value fields from source filings.
 * Enrichment never marks a deal reviewed; the strict transaction-review engine is
 * the only component allowed to clear publication review requirements.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const sharedPath = fs.existsSync(path.join(__dirname, '../services/shared/deal-extraction.js'))
  ? '../services/shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractDeal, distinctParties, normalizeName } = require(sharedPath);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true },
  max: 3,
  statement_timeout: 60000,
});

const BATCH = Math.max(1, Math.min(5000, Number.parseInt(process.env.BATCH || '200', 10) || 200));
const DELAY = Math.max(100, Number.parseInt(process.env.ENRICH_DELAY_MS || '700', 10) || 700);
const PLACEHOLDER_RE = /^(?:disclosed in filing|public company target \(see filing\)|acquirer \(see filing\)|target \(see filing\)|unknown|undisclosed|n\/a)$/i;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isPlaceholder(value) {
  return !value || PLACEHOLDER_RE.test(String(value).trim());
}

function fetchText(url, redirects = 0) {
  if (!url || !/^https:\/\//i.test(url)) return Promise.resolve('');
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'mergers.news contact@mergers.news',
        Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        return fetchText(next, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (bytes >= 2_000_000) return;
        const remaining = 2_000_000 - bytes;
        const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(part);
        bytes += part.length;
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Source fetch timeout')));
  });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function upsertCompany(client, name) {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error(`Invalid company name: ${name}`);
  const existing = await client.query(
    'SELECT id FROM companies WHERE normalized_name=$1 ORDER BY created_at NULLS LAST,id LIMIT 1',
    [normalized.slice(0, 500)]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    'INSERT INTO companies(name,normalized_name) VALUES($1,$2) RETURNING id',
    [String(name).slice(0, 500), normalized.slice(0, 500)]
  );
  return inserted.rows[0].id;
}

async function candidateRows() {
  return (await db.query(`
    SELECT DISTINCT ON (d.id)
      d.id AS deal_id,d.deal_value,d.headline,d.extracted_acquirer_name,d.extracted_target_name,
      a.name AS acquirer_name,a.id AS acquirer_id,t.name AS target_name,t.id AS target_id,
      f.filing_type,f.document_url,f.edgar_url,
      COALESCE(f.document_url,f.edgar_url,ds.source_url) AS source_url
    FROM deals d
    LEFT JOIN companies a ON a.id=d.acquirer_id
    LEFT JOIN companies t ON t.id=d.target_id
    LEFT JOIN filings f ON f.deal_id=d.id
    LEFT JOIN deal_sources ds ON ds.deal_id=d.id
    WHERE d.canonical_id IS NULL
      AND (
        a.id IS NULL OR t.id IS NULL OR
        COALESCE(a.name,'') ~* $1 OR COALESCE(t.name,'') ~* $1 OR
        d.deal_value IS NULL
      )
    ORDER BY d.id,
      CASE WHEN f.document_url IS NOT NULL THEN 0 WHEN f.edgar_url IS NOT NULL THEN 1 ELSE 2 END,
      f.filing_date DESC NULLS LAST,ds.source_date DESC NULLS LAST
    LIMIT $2
  `, ['^(disclosed in filing|public company target \\(see filing\\)|acquirer \\(see filing\\)|target \\(see filing\\)|unknown|undisclosed|n/a)$', BATCH])).rows;
}

async function enrichRow(row) {
  if (!row.source_url) return 'skipped';
  const source = stripHtml(await fetchText(row.source_url));
  if (source.length < 100) return 'skipped';

  const extracted = extractDeal(source, {
    filingType: row.filing_type,
    issuer: !isPlaceholder(row.target_name) ? row.target_name : (!isPlaceholder(row.acquirer_name) ? row.acquirer_name : null),
  });

  const currentAcquirer = isPlaceholder(row.acquirer_name) ? null : row.acquirer_name;
  const currentTarget = isPlaceholder(row.target_name) ? null : row.target_name;
  const acquirerName = currentAcquirer || extracted.acquirer || null;
  const targetName = currentTarget || extracted.target || null;

  // Never apply the same generic extracted party to both roles.
  if (acquirerName && targetName && !distinctParties(acquirerName, targetName)) {
    return 'skipped';
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let changed = false;
    let acquirerId = row.acquirer_id;
    let targetId = row.target_id;

    if (!currentAcquirer && extracted.acquirer) {
      acquirerId = await upsertCompany(client, extracted.acquirer);
      changed = true;
    }
    if (!currentTarget && extracted.target) {
      targetId = await upsertCompany(client, extracted.target);
      changed = true;
    }

    const valueCents = !row.deal_value && extracted.dealValue
      ? Math.round(Number(extracted.dealValue) * 100)
      : null;
    if (valueCents && Number.isSafeInteger(valueCents) && valueCents > 0) changed = true;

    if (changed) {
      await client.query(`
        UPDATE deals SET
          acquirer_id=$1,
          target_id=$2,
          extracted_acquirer_name=COALESCE($3,extracted_acquirer_name),
          extracted_target_name=COALESCE($4,extracted_target_name),
          deal_value=COALESCE($5,deal_value),
          needs_review=true,
          review_status='pending',
          next_review_at=NOW(),
          updated_at=NOW()
        WHERE id=$6
      `, [
        acquirerId || null,targetId || null,
        extracted.acquirer || null,extracted.target || null,
        valueCents,row.deal_id,
      ]);
    }

    await client.query('COMMIT');
    return changed ? 'enriched' : 'skipped';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  const rows = await candidateRows();
  console.log(`[ENRICH] ${rows.length} candidate deal(s); batch=${BATCH}`);
  const stats = { enriched: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    try {
      const status = await enrichRow(row);
      stats[status]++;
    } catch (error) {
      stats.failed++;
      console.error(`[ENRICH] ${row.deal_id}: ${error.message}`);
    }
    await sleep(DELAY);
  }

  console.log('[ENRICH] Complete', stats);
  if (stats.failed && stats.failed === rows.length && rows.length) {
    throw new Error('Every enrichment candidate failed');
  }
  return stats;
}

module.exports = { run, enrichRow, isPlaceholder };

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      console.error('[ENRICH] Fatal:', error);
      await db.end().catch(() => {});
      process.exitCode = 1;
    });
}
