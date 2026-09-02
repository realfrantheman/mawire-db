'use strict';

/**
 * APAC exchange announcement ingestion.
 *
 * Uses current official exchange announcement surfaces, inserts only candidates
 * with two distinct transaction parties, stores APAC in region (never sector),
 * and leaves every record behind the strict publication review gate.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const extractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractDeal, distinctParties, normalizeName, rawSnippet, withRetry } = require(extractionPath);

const sourceUrlPath = fs.existsSync(path.join(__dirname, '../shared/source-url.js'))
  ? '../shared/source-url'
  : './FIX-source-url';
const { resolvePrimaryHttpUrl } = require(sourceUrlPath);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true },
  max: 4,
  statement_timeout: 60000,
});

db.on('error', error => console.error('[APAC] idle DB client error:', error.message));

const CONTROL_HINT_RE = /\b(?:acqui(?:re|res|red|sition)|merger|merge|takeover|scheme of arrangement|scheme implementation|tender offer|going[- ]private|privati[sz]ation|recommended (?:cash )?offer|bid for|buyout)\b/i;
const NON_CONTROL_RE = /\b(?:minority stake|minority investment|strategic investment|joint venture|partnership|share buyback|stock buyback|repurchase|placement|rights issue|capital raising|funding round)\b/i;

function trunc(value, length) {
  return value == null ? value : String(value).slice(0, length);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'mergers.news contact@mergers.news',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const html = await response.text();
  if (!/<(?:html|table|a|tr)\b/i.test(html)) throw new Error(`Unexpected response from ${url}`);
  return html;
}

function absoluteUrl(href, base) {
  try { return new URL(String(href || '').replace(/&amp;/g, '&'), base).href; }
  catch { return null; }
}

function todayYYYYMMDD(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let match = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = raw.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function candidate(title, sourceUrl, sourceType, sourceName, sourceDate, context = '') {
  const combined = `${title || ''}. ${context || ''}`.replace(/\s+/g, ' ').trim();
  if (!combined || NON_CONTROL_RE.test(combined) || !CONTROL_HINT_RE.test(combined)) return null;
  const extracted = extractDeal(combined, { sourceReliability: 16, dedupCertainty: 2 });
  if (!distinctParties(extracted.acquirer, extracted.target)) return null;
  if (extracted.disposition === 'rejected') return null;
  return {
    title: trunc(title || combined, 500),
    sourceUrl,
    sourceType,
    sourceName,
    sourceDate,
    combined,
    extracted,
  };
}

function parseRows(html, baseUrl, sourceType, sourceName, defaultDate) {
  const results = [];
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const rowText = decodeHtml(row);
    if (!CONTROL_HINT_RE.test(rowText) || NON_CONTROL_RE.test(rowText)) continue;
    const links = Array.from(row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
    if (!links.length) continue;
    // Prefer document/PDF links; fall back to the last meaningful anchor.
    const selected = links.find(link => /\.pdf(?:[?#]|$)|announcement|document|display/i.test(link[1])) || links[links.length - 1];
    const href = absoluteUrl(selected[1], baseUrl);
    const anchorText = decodeHtml(selected[2]);
    const title = anchorText && CONTROL_HINT_RE.test(anchorText) ? anchorText : rowText;
    const sourceDate = parseDate(rowText) || defaultDate;
    if (href) results.push({ title: trunc(title, 500), url: href, sourceType, sourceName, sourceDate, context: rowText });
  }
  return results;
}

async function loadAsx() {
  const url = 'https://www.asx.com.au/asx/v2/statistics/todayAnns.do';
  const html = await withRetry(() => fetchHtml(url), { attempts: 3, baseDelayMs: 1000 });
  return parseRows(html, url, 'asx', 'ASX Company Announcements', new Date().toISOString().slice(0, 10));
}

async function loadHkex() {
  const records = [];
  for (const offset of [0, -1]) {
    const yyyymmdd = todayYYYYMMDD(offset);
    const year = yyyymmdd.slice(0, 4);
    const mmdd = yyyymmdd.slice(4);
    const url = `https://www.hkexnews.hk/listedco/listconews/sehk/${year}/${mmdd}/LIST.HTM`;
    try {
      const html = await withRetry(() => fetchHtml(url), { attempts: 2, baseDelayMs: 750 });
      records.push(...parseRows(html, 'https://www1.hkexnews.hk/', 'hkex', 'HKEX News', `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`));
    } catch (error) {
      // One non-trading date should not hide a reachable adjacent-day source.
      if (offset === -1 && !records.length) throw error;
      console.warn(`[APAC/HKEX] ${yyyymmdd}: ${error.message}`);
    }
  }
  return records;
}

function parseSgxLinks(html) {
  const url = 'https://www.sgx.com/securities/company-announcements';
  const output = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = decodeHtml(match[2]);
    if (!CONTROL_HINT_RE.test(title) || NON_CONTROL_RE.test(title)) continue;
    const href = absoluteUrl(match[1], url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    output.push({
      title: trunc(title, 500),url: href,sourceType: 'sgx',sourceName: 'SGX Company Announcements',
      sourceDate: new Date().toISOString().slice(0, 10),context: title,
    });
  }
  return output;
}

async function loadSgx() {
  const url = 'https://www.sgx.com/securities/company-announcements';
  const html = await withRetry(() => fetchHtml(url), { attempts: 3, baseDelayMs: 1000 });
  return parseSgxLinks(html);
}

async function upsertCompany(client, name) {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error(`Invalid company name: ${name}`);
  const existing = await client.query('SELECT id FROM companies WHERE normalized_name=$1 ORDER BY id LIMIT 1', [trunc(normalized, 500)]);
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    'INSERT INTO companies(name,normalized_name) VALUES($1,$2) RETURNING id',
    [trunc(name, 500),trunc(normalized, 500)]
  );
  return inserted.rows[0].id;
}

async function processAnnouncement(record) {
  const item = candidate(record.title, record.url, record.sourceType, record.sourceName, record.sourceDate, record.context);
  if (!item) return 'skip';
  const sourceUrl = trunc(await resolvePrimaryHttpUrl(item.sourceUrl) || item.sourceUrl, 500);
  if (!sourceUrl) return 'skip';
  const duplicate = await db.query('SELECT 1 FROM deal_sources WHERE source_url=$1 LIMIT 1', [sourceUrl]);
  if (duplicate.rows.length) return 'skip';

  const { extracted } = item;
  const valueCents = extracted.value ? Math.round(Number(extracted.value) * 100) : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const acquirerId = await upsertCompany(client, extracted.acquirer);
    const targetId = await upsertCompany(client, extracted.target);
    const deal = await client.query(`
      INSERT INTO deals(
        acquirer_id,target_id,headline,deal_type,status,announcement_date,filing_date,
        deal_value,per_share_value,premium_pct,sector,region,source_confidence,
        extraction_method,needs_review,extracted_acquirer_name,extracted_target_name,
        raw_extracted_snippet
      ) VALUES($1,$2,$3,$4,'Announced',$5,$5,$6,$7,$8,NULL,'APAC',$9,$10,true,$11,$12,$13)
      RETURNING id
    `, [
      acquirerId,targetId,item.title,extracted.dealType || 'Acquisition',item.sourceDate,
      valueCents,extracted.perShare || null,extracted.premium || null,
      Math.max(0.65, Math.min(0.9, Number(extracted.confidence) || 0.65)),
      `${item.sourceType}_announcement`,extracted.acquirer,extracted.target,rawSnippet(item.combined),
    ]);
    await client.query(`
      INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,raw_content,confidence)
      VALUES($1,$2,$3,$4,$5,$6,$7)
    `, [
      deal.rows[0].id,item.sourceType,trunc(item.sourceName, 100),sourceUrl,item.sourceDate,
      rawSnippet(item.combined),Math.max(0.7, Math.min(0.95, Number(extracted.confidence) || 0.7)),
    ]);
    await client.query('COMMIT');
    return 'new';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function startLog() {
  const result = await db.query("INSERT INTO ingestion_log(source,run_started_at,status) VALUES('apac',NOW(),'running') RETURNING id");
  return result.rows[0].id;
}

async function endLog(id, status, stats, errorMessage) {
  await db.query(`
    UPDATE ingestion_log SET run_ended_at=NOW(),status=$1,records_fetched=$2,
      records_new=$3,records_updated=0,records_failed=$4,error_message=$5
    WHERE id=$6
  `, [status,stats.fetched,stats.new,stats.failed,errorMessage || null,id]);
}

async function run() {
  const logId = await startLog();
  const stats = { fetched: 0, new: 0, failed: 0, sourcesSucceeded: 0, sourcesFailed: 0 };
  const errors = [];
  try {
    const adapters = [
      ['HKEX', loadHkex],
      ['ASX', loadAsx],
      ['SGX', loadSgx],
    ];
    for (const [name, load] of adapters) {
      try {
        const records = await load();
        stats.sourcesSucceeded++;
        stats.fetched += records.length;
        console.log(`[APAC/${name}] ${records.length} M&A candidate announcement(s)`);
        for (const record of records) {
          try {
            if (await processAnnouncement(record) === 'new') stats.new++;
          } catch (error) {
            stats.failed++;
            console.error(`[APAC/${name}] ${trunc(record.title, 80)}: ${error.message}`);
          }
        }
      } catch (error) {
        stats.sourcesFailed++;
        errors.push(`${name}: ${error.message}`);
        console.error('[APAC]', errors[errors.length - 1]);
      }
      await sleep(500);
    }

    if (!stats.sourcesSucceeded) throw new Error(`All APAC exchange sources failed (${errors.join('; ')})`);
    await endLog(logId, 'success', stats, errors.length ? errors.join('; ').slice(0, 1000) : null);
    console.log('[APAC] Complete', stats);
    return stats;
  } catch (error) {
    await endLog(logId, 'failed', stats, error.message).catch(() => {});
    throw error;
  }
}

module.exports = {
  run,candidate,parseRows,parseSgxLinks,parseDate,
};

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      console.error('[APAC] Fatal:', error);
      await db.end().catch(() => {});
      process.exitCode = 1;
    });
}
