'use strict';

/**
 * EU merger ingestion.
 *
 * Source of truth: the European Commission / data.europa.eu merger-case
 * publication dataset. The implementation resolves the current JSON
 * distribution at runtime instead of scraping the interactive search UI.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const extractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { cleanCompanyName, distinctParties, normalizeName, withRetry } = require(extractionPath);

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

db.on('error', error => console.error('[EU] idle DB client error:', error.message));

const DATASET_ID = 'cc7e224e-6569-40f0-8037-d3389aa0fae7';
const DATASET_PAGE = `https://data.europa.eu/data/datasets/${DATASET_ID}?locale=en`;
const DATASET_API = `https://data.europa.eu/api/hub/search/datasets/${DATASET_ID}`;
const MAX_CASES_PER_RUN = Math.max(25, Math.min(1000, Number.parseInt(process.env.EU_MAX_CASES || '250', 10) || 250));

function trunc(value, length) {
  return value == null ? value : String(value).slice(0, length);
}

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' / ');
  if (typeof value === 'object') {
    for (const key of ['en', 'value', '@value', 'label', 'name', 'title']) {
      if (value[key] != null) {
        const candidate = text(value[key]);
        if (candidate) return candidate;
      }
    }
  }
  return '';
}

function getField(record, names) {
  const lowered = new Map(Object.keys(record || {}).map(key => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), key]));
  for (const name of names) {
    const exact = lowered.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (exact) {
      const value = text(record[exact]);
      if (value) return value;
    }
  }
  return '';
}

async function fetchTextStrict(url, accept = 'application/json,text/plain,text/html,*/*') {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'mergers.news contact@mergers.news',
      Accept: accept,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

async function fetchJsonStrict(url) {
  const body = await fetchTextStrict(url, 'application/json,application/ld+json;q=0.9,*/*;q=0.5');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Expected JSON from ${url}: ${error.message}`);
  }
}

function collectHttpUrls(value, output = [], keyHint = '') {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) output.push({ url: value, key: keyHint });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectHttpUrls(item, output, keyHint));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => collectHttpUrls(child, output, key));
  }
  return output;
}

function scoreDistributionUrl(candidate) {
  const key = candidate.key.toLowerCase();
  const url = candidate.url.toLowerCase();
  let score = 0;
  if (/download/.test(key)) score += 100;
  if (/access/.test(key)) score += 60;
  if (/distribution/.test(key)) score += 30;
  if (/\.json(?:[?#]|$)/.test(url)) score += 80;
  if (/format=json/.test(url)) score += 50;
  if (/competition|merger/.test(url)) score += 20;
  if (/data\.europa\.eu\/data\/datasets\//.test(url)) score -= 100;
  if (/competition-cases\.ec\.europa\.eu\/search/.test(url)) score -= 100;
  return score;
}

async function discoverDistributionUrl() {
  if (process.env.EU_MERGER_DATA_URL) return process.env.EU_MERGER_DATA_URL;

  const errors = [];
  try {
    const metadata = await fetchJsonStrict(DATASET_API);
    const candidates = collectHttpUrls(metadata)
      .map(candidate => ({ ...candidate, score: scoreDistributionUrl(candidate) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (candidates[0]) return candidates[0].url;
    errors.push('metadata API contained no usable distribution URL');
  } catch (error) {
    errors.push(`metadata API: ${error.message}`);
  }

  // The dataset landing page contains distribution metadata even if the search
  // API is temporarily unavailable. Extract only explicit HTTP JSON resources.
  try {
    const html = await fetchTextStrict(DATASET_PAGE, 'text/html,application/xhtml+xml');
    const matches = Array.from(html.matchAll(/https?:\\?\/\\?\/[^"'<>\\s]+/gi))
      .map(match => match[0].replace(/\\\//g, '/').replace(/&amp;/g, '&'))
      .filter(url => /json|download|distribution/i.test(url))
      .map(url => ({ url, key: 'landing-page', score: scoreDistributionUrl({ url, key: 'download' }) }))
      .sort((a, b) => b.score - a.score);
    if (matches[0]) return matches[0].url;
    errors.push('dataset landing page contained no usable distribution URL');
  } catch (error) {
    errors.push(`dataset landing page: ${error.message}`);
  }

  throw new Error(`Unable to resolve EU merger JSON distribution (${errors.join('; ')})`);
}

function looksLikeCase(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const caseNumber = getField(record, ['caseNumber', 'case_number', 'caseNo', 'case_id', 'caseId', 'reference', 'case']);
  const title = getField(record, ['title', 'caseTitle', 'case_title', 'name']);
  return /^M\.?\s*\d+/i.test(caseNumber) || (/\bM\.\d+\b/i.test(title) && title.length > 3);
}

function collectCaseObjects(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (looksLikeCase(value)) output.push(value);
  if (Array.isArray(value)) value.forEach(item => collectCaseObjects(item, output, seen));
  else Object.values(value).forEach(item => collectCaseObjects(item, output, seen));
  return output;
}

function normalizeCaseNumber(value) {
  const match = String(value || '').match(/\bM\.?\s*(\d{3,6})\b/i);
  return match ? `M.${match[1]}` : null;
}

function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function mapStatus(value) {
  const raw = String(value || '').toLowerCase();
  if (/prohibit|blocked|incompatib|article 8\(3\)/.test(raw)) return 'Terminated';
  if (/withdraw|abandon/.test(raw)) return 'Withdrawn';
  if (/approve|approved|clear|compatible|decision|article 6\(1\)\(b\)|article 8\(1\)|article 8\(2\)/.test(raw)) return 'Completed';
  return 'Announced';
}

function parseParties(title) {
  const clean = String(title || '').replace(/^M\.\d+\s*[-–:]?\s*/i, '').trim();
  const pieces = clean.split(/\s+\/\s+|\s+\+\s+/).map(piece => cleanCompanyName(piece)).filter(Boolean);
  if (pieces.length >= 2 && distinctParties(pieces[0], pieces[1])) {
    return { acquirer: pieces[0], target: pieces.slice(1).join(' / ') };
  }
  return { acquirer: null, target: null };
}

function normalizeCase(record) {
  const rawNumber = getField(record, ['caseNumber', 'case_number', 'caseNo', 'case_id', 'caseId', 'reference', 'case']) || getField(record, ['title', 'caseTitle']);
  const caseNumber = normalizeCaseNumber(rawNumber);
  if (!caseNumber) return null;
  const title = getField(record, ['title', 'caseTitle', 'case_title', 'name']) || caseNumber;
  const notificationDate = parseDate(getField(record, ['notificationDate', 'notification_date', 'dateOfNotification', 'notification', 'date']));
  const decisionDate = parseDate(getField(record, ['decisionDate', 'decision_date', 'dateOfDecision']));
  const statusText = getField(record, ['status', 'outcome', 'decisionType', 'decision_type', 'phase', 'procedure']);
  const explicitUrl = getField(record, ['documentUrl', 'document_url', 'decisionUrl', 'decision_url', 'caseUrl', 'case_url', 'url']);
  return {
    caseNumber,
    title,
    announcementDate: notificationDate || decisionDate,
    status: mapStatus(statusText),
    sourceUrl: explicitUrl || `https://competition-cases.ec.europa.eu/cases/${encodeURIComponent(caseNumber)}`,
  };
}

async function upsertCompany(client, name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const existing = await client.query('SELECT id FROM companies WHERE normalized_name=$1 ORDER BY id LIMIT 1', [normalized.slice(0, 500)]);
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query('INSERT INTO companies(name,normalized_name) VALUES($1,$2) RETURNING id', [trunc(name, 500), trunc(normalized, 500)]);
  return inserted.rows[0].id;
}

async function processCase(item) {
  const sourceUrl = trunc(await resolvePrimaryHttpUrl(item.sourceUrl) || item.sourceUrl, 500);
  if (!sourceUrl) throw new Error(`${item.caseNumber}: no source URL`);

  const existing = await db.query('SELECT 1 FROM deal_sources WHERE source_url=$1 LIMIT 1', [sourceUrl]);
  if (existing.rows.length) return 'skip';

  const parties = parseParties(item.title);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const acquirerId = parties.acquirer ? await upsertCompany(client, parties.acquirer) : null;
    const targetId = parties.target ? await upsertCompany(client, parties.target) : null;
    const deal = await client.query(`
      INSERT INTO deals(
        acquirer_id,target_id,headline,deal_type,status,announcement_date,filing_date,
        deal_value,sector,region,source_confidence,extraction_method,needs_review,
        extracted_acquirer_name,extracted_target_name
      ) VALUES($1,$2,$3,'Merger',$4,$5,$5,NULL,NULL,'Europe',$6,'eu_merger_registry',true,$7,$8)
      RETURNING id
    `, [
      acquirerId,targetId,trunc(item.title, 500),item.status,item.announcementDate,
      distinctParties(parties.acquirer, parties.target) ? 0.9 : 0.72,
      parties.acquirer,parties.target,
    ]);
    await client.query(`
      INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,confidence)
      VALUES($1,'eu_merger_registry','European Commission Competition',$2,$3,$4)
    `, [deal.rows[0].id, sourceUrl, item.announcementDate, distinctParties(parties.acquirer, parties.target) ? 0.95 : 0.8]);
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
  const result = await db.query("INSERT INTO ingestion_log(source,run_started_at,status) VALUES('eu',NOW(),'running') RETURNING id");
  return result.rows[0].id;
}

async function endLog(id, status, stats, errorMessage) {
  await db.query(`
    UPDATE ingestion_log SET run_ended_at=NOW(),status=$1,records_fetched=$2,
      records_new=$3,records_updated=0,records_failed=$4,error_message=$5
    WHERE id=$6
  `, [status, stats.fetched, stats.new, stats.failed, errorMessage || null, id]);
}

async function run() {
  const logId = await startLog();
  const stats = { fetched: 0, new: 0, failed: 0 };
  try {
    const distributionUrl = await discoverDistributionUrl();
    console.log('[EU] JSON distribution:', distributionUrl);
    const payload = await withRetry(() => fetchJsonStrict(distributionUrl), { attempts: 3, baseDelayMs: 1500 });
    const unique = new Map();
    collectCaseObjects(payload).map(normalizeCase).filter(Boolean).forEach(item => unique.set(item.caseNumber, item));
    const cases = Array.from(unique.values())
      .sort((a, b) => String(b.announcementDate || '').localeCompare(String(a.announcementDate || '')))
      .slice(0, MAX_CASES_PER_RUN);
    if (!cases.length) throw new Error('EU merger dataset contained no recognizable merger cases');
    stats.fetched = cases.length;

    for (const item of cases) {
      try {
        if (await processCase(item) === 'new') stats.new++;
      } catch (error) {
        stats.failed++;
        console.error(`[EU] ${item.caseNumber}: ${error.message}`);
      }
    }

    if (stats.failed === stats.fetched) throw new Error('All EU merger cases failed processing');
    await endLog(logId, 'success', stats);
    console.log('[EU] Complete', stats);
    return stats;
  } catch (error) {
    await endLog(logId, 'failed', stats, error.message).catch(() => {});
    console.error('[EU] Fatal:', error);
    throw error;
  }
}

module.exports = { run, discoverDistributionUrl, normalizeCase, mapStatus, parseParties };

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      await db.end().catch(() => {});
      console.error('[EU] Exiting with failure:', error.message);
      process.exitCode = 1;
    });
}
