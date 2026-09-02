/**
 * mergers.news — GDELT News Ingestion Service
 * GDELT GKG archives are ZIP files (not gzip). This implementation parses the
 * single-file ZIP archive directly with Node built-ins and keeps its DB pool
 * alive when run repeatedly by the long-lived scheduler.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Pool } = require('pg');

const sharedExtractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { rawSnippet, withRetry } = require(sharedExtractionPath);

const extractorPath = fs.existsSync(path.join(__dirname, '../ai-extraction/extractor.js'))
  ? '../ai-extraction/extractor'
  : './services/ai-extraction/extractor';

let pool = null;
function getDb() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true },
      max: 6,
      statement_timeout: 120000,
    });
    pool.on('error', error => console.error('[GDELT] idle database client error:', error.message));
  }
  return pool;
}

const GKG_FIELDS = { DATE: 0, SOURCEURL: 4, THEMES: 7, PERSONS: 11, ORGS: 12, TONE: 15, AMOUNTS: 16 };
const MA_THEMES = ['ECON_MERGER', 'ECON_ACQUISITION', 'ECON_BUYOUT', 'ECON_INVEST', 'BUS_FINANCE', 'ECON_DEAL'];
const MA_KEYWORDS = ['acquires', 'acquisition', 'merger', 'buyout', 'takeover', 'tender offer', 'going private', 'buys', 'purchased', 'deal worth', 'valued at'];
const USER_AGENT = 'mergers.news contact@mergers.news';

async function startLog() {
  const result = await getDb().query(`INSERT INTO ingestion_log(source,run_started_at,status) VALUES('gdelt',NOW(),'running') RETURNING id`);
  return result.rows[0].id;
}

async function endLog(id, status, stats, errorMessage = null) {
  await getDb().query(`UPDATE ingestion_log SET run_ended_at=NOW(),records_fetched=$2,records_new=$3,records_updated=$4,records_failed=$5,status=$6,error_message=$7,duration_ms=EXTRACT(EPOCH FROM (NOW()-run_started_at))*1000 WHERE id=$1`, [id, stats.fetched, stats.new, stats.updated, stats.failed, status, errorMessage]);
}

async function run() {
  const logId = await startLog();
  const stats = { fetched: 0, new: 0, updated: 0, failed: 0 };
  try {
    console.log('[GDELT] Starting ingestion run at', new Date().toISOString());
    const latestUrl = await getLatestGKGUrl();
    if (!latestUrl) throw new Error('GDELT lastupdate.txt did not contain a GKG archive');

    const records = await fetchAndParseGKG(latestUrl);
    stats.fetched = records.length;
    const maRecords = records.filter(isMARecord);
    console.log(`[GDELT] Parsed ${records.length} records; ${maRecords.length} M&A candidates`);

    for (const record of maRecords) {
      try {
        const result = await processGDELTRecord(record);
        if (result === 'new') stats.new++;
        if (result === 'enriched') stats.updated++;
      } catch (error) {
        stats.failed++;
        console.error('[GDELT] Record error:', error.message);
      }
    }

    await endLog(logId, 'success', stats);
    console.log('[GDELT] Complete:', stats);
    return stats;
  } catch (error) {
    stats.failed++;
    await endLog(logId, 'failed', stats, error.message).catch(() => {});
    console.error('[GDELT] Fatal:', error.stack || error.message);
    throw error;
  }
}

async function close() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

async function getLatestGKGUrl() {
  const text = await withRetry(() => fetchText('http://data.gdeltproject.org/gdeltv2/lastupdate.txt'), { attempts: 4, baseDelayMs: 1000 });
  const line = String(text || '').trim().split('\n').find(value => value.includes('.gkg.csv.zip'));
  if (!line) return null;
  return line.trim().split(/\s+/).pop();
}

function findSignatureFromEnd(buffer, signature) {
  for (let i = buffer.length - 4; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function unzipSingleFile(buffer) {
  const eocd = findSignatureFromEnd(buffer, 0x06054b50);
  if (eocd < 0) throw new Error('Invalid ZIP: end-of-central-directory not found');
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error('Invalid ZIP: no entries');
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP: central directory entry missing');

  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP: local header missing');
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${method}`);
}

async function fetchAndParseGKG(url) {
  const archive = await withRetry(() => fetchBuffer(url, 100 * 1024 * 1024), { attempts: 3, baseDelayMs: 1500 });
  const csv = unzipSingleFile(archive).toString('utf8');
  const records = [];
  for (const line of csv.split('\n')) {
    if (!line.trim()) continue;
    const record = parseGKGLine(line);
    if (record) records.push(record);
  }
  return records;
}

function parseGKGLine(line) {
  const fields = line.split('\t');
  if (fields.length < 17) return null;
  const date = fields[GKG_FIELDS.DATE];
  const sourceUrl = fields[GKG_FIELDS.SOURCEURL];
  if (!sourceUrl || !date) return null;
  return {
    date,
    sourceUrl,
    themes: fields[GKG_FIELDS.THEMES] || '',
    orgs: fields[GKG_FIELDS.ORGS] || '',
    amounts: fields[GKG_FIELDS.AMOUNTS] || '',
    raw: line.slice(0, 1000),
  };
}

function isMARecord(record) {
  if (MA_THEMES.some(theme => record.themes.includes(theme))) return true;
  const text = `${record.themes} ${record.sourceUrl}`.toLowerCase();
  return MA_KEYWORDS.some(keyword => text.includes(keyword));
}

async function processGDELTRecord(record) {
  const db = getDb();
  const existing = await db.query(`SELECT source_url FROM deal_sources WHERE source_url=$1 UNION ALL SELECT source_url FROM ingestion_raw_sources WHERE source_url=$1 LIMIT 1`, [record.sourceUrl]);
  if (existing.rows.length) return 'skip';

  const articleText = await fetchArticleText(record.sourceUrl);
  const extractor = require(extractorPath);
  const extracted = articleText ? extractor.extractDealInfo(articleText, null, null) : null;

  if (!extracted || (!extracted.acquirer && !extracted.target)) {
    await db.query(`INSERT INTO ingestion_raw_sources(source_type,source_url,source_date,raw_content,processing_status) VALUES('gdelt',$1,$2,$3,'needs_review') ON CONFLICT(source_url) DO UPDATE SET raw_content=EXCLUDED.raw_content,updated_at=NOW()`, [record.sourceUrl, parseGDELTDate(record.date), record.raw]);
    return 'no_deal';
  }

  const matchedDealId = await findMatchingDeal(extracted);
  if (matchedDealId) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,raw_content,confidence) VALUES($1,'gdelt','GDELT News',$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [matchedDealId, record.sourceUrl, parseGDELTDate(record.date), rawSnippet(articleText || record.raw), Math.min(0.6, Number(extracted.confidence || 0.3))]);
      await client.query('UPDATE deals SET source_confidence=LEAST(0.95,source_confidence+0.05),updated_at=NOW() WHERE id=$1', [matchedDealId]);
      await client.query('COMMIT');
      return 'enriched';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  await createDealFromGDELT(extracted, record);
  return 'new';
}

async function upsertCompany(client, name) {
  if (!name) return null;
  const normalized = normalizeName(name);
  if (!normalized) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mawire:company:${normalized}`]);
  const existing = await client.query('SELECT id FROM companies WHERE normalized_name=$1 ORDER BY created_at,id LIMIT 1', [normalized]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await client.query('INSERT INTO companies(name,normalized_name) VALUES($1,$2) RETURNING id', [name, normalized]);
  return inserted.rows[0].id;
}

async function createDealFromGDELT(extracted, record) {
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    const acquirerId = await upsertCompany(client, extracted.acquirer);
    const targetId = await upsertCompany(client, extracted.target);
    const confidence = Math.min(0.6, Number(extracted.confidence || 0.3));
    const date = extracted.announcement_date || parseGDELTDate(record.date);

    const deal = await client.query(`
      INSERT INTO deals(acquirer_id,target_id,headline,deal_type,status,deal_value,per_share_value,premium_pct,announcement_date,sector,source_confidence,extraction_method,needs_review,extracted_acquirer_name,extracted_target_name,raw_extracted_snippet)
      VALUES($1,$2,$3,$4,'Announced',$5,$6,$7,$8,$9,$10,'gdelt_news',true,$11,$12,$13)
      RETURNING id
    `, [
      acquirerId,
      targetId,
      extracted.headline || `${extracted.acquirer || 'Unknown acquirer'} / ${extracted.target || 'Unknown target'}`,
      extracted.deal_type || 'Merger',
      extracted.deal_value_usd ? Math.round(Number(extracted.deal_value_usd) * 100) : null,
      extracted.per_share_value || null,
      extracted.premium_pct ?? null,
      date,
      extracted.sector || null,
      confidence,
      extracted.acquirer || null,
      extracted.target || null,
      rawSnippet(record.raw),
    ]);

    await client.query(`INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,raw_content,confidence) VALUES($1,'gdelt','GDELT News',$2,$3,$4,$5)`, [deal.rows[0].id, record.sourceUrl, parseGDELTDate(record.date), rawSnippet(record.raw), confidence]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function findMatchingDeal(extracted) {
  const acquirerNorm = extracted.acquirer ? normalizeName(extracted.acquirer) : null;
  const targetNorm = extracted.target ? normalizeName(extracted.target) : null;
  if (!acquirerNorm && !targetNorm) return null;

  const result = await getDb().query(`
    SELECT d.id
    FROM deals d
    LEFT JOIN companies a ON d.acquirer_id=a.id
    LEFT JOIN companies t ON d.target_id=t.id
    WHERE d.canonical_id IS NULL
      AND ($1::text IS NULL OR a.normalized_name=$1)
      AND ($2::text IS NULL OR t.normalized_name=$2)
      AND ($3::date IS NULL OR d.announcement_date IS NULL OR ABS(d.announcement_date-$3::date)<180)
    ORDER BY CASE WHEN $3::date IS NULL OR d.announcement_date IS NULL THEN 999999 ELSE ABS(d.announcement_date-$3::date) END,
             d.source_confidence DESC,d.created_at DESC,d.id
    LIMIT 1
  `, [acquirerNorm, targetNorm, extracted.announcement_date || null]);
  return result.rows[0]?.id || null;
}

function parseGDELTDate(value) {
  if (!value || String(value).length < 8) return null;
  const date = String(value);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function normalizeName(name) {
  return String(name || '').toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function request(url, maxBytes, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('HTTP redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url).toString(), maxBytes, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`Response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

async function fetchBuffer(url, maxBytes) {
  return request(url, maxBytes);
}

async function fetchText(url) {
  const buffer = await request(url, 10 * 1024 * 1024);
  return buffer.toString('utf8');
}

async function fetchArticleText(url) {
  try {
    const text = await withRetry(() => fetchText(url), { attempts: 2, baseDelayMs: 500 });
    return text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);
  } catch (error) {
    console.warn('[GDELT] Article fetch failed:', error.message);
    return null;
  }
}

module.exports = { run, close, parseGKGLine, isMARecord, unzipSingleFile, normalizeName, findMatchingDeal };

if (require.main === module) {
  run()
    .then(() => close())
    .catch(async error => {
      console.error(error.stack || error);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}
