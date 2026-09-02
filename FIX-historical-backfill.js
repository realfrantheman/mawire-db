/**
 * mergers.news — Historical SEC M&A backfill
 * Idempotent by accession, transaction-safe, and safe for the SEC EFTS 10k
 * result cap by recursively partitioning high-volume date ranges.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const sharedExtractionPath = fs.existsSync(path.join(__dirname, '../services/shared/deal-extraction.js'))
  ? '../services/shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractParties, firstReliable, isReliableName, rawSnippet } = require(sharedExtractionPath);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 6,
  statement_timeout: 120000,
});

const FILING_TYPES = ['DEFM14A', 'PREM14A', 'DEFA14A', 'SC TO-T', 'SC TO-T/A', 'S-4', 'S-4/A', 'SC 13E-3', 'SC 13E-3/A'];
const START_YEAR = Number.parseInt(process.env.BACKFILL_START_YEAR || '1993', 10);
const END_YEAR = Number.parseInt(process.env.BACKFILL_END_YEAR || String(new Date().getUTCFullYear()), 10);
const DELAY_MS = 400;
const TIME_LIMIT_MS = Number.parseInt(process.env.BACKFILL_TIME_LIMIT_MINUTES || '100', 10) * 60 * 1000;
const USER_AGENT = 'mergers.news contact@mergers.news';
const FILING_AGENT_PATTERNS = [/\/FA$/i, /- FA$/i, /EDGARFILINGS/i, /FILING SERVICES/i, /FILING AGENT/i, /DONNELLEY\s+FINANCIAL/i, /^BCP INVESTMENT CORP\b/i];

async function run() {
  await ensureIngestionSchema();
  const log = await db.query(`INSERT INTO ingestion_log(source,run_started_at,status) VALUES('sec_historical',NOW(),'running') RETURNING id`);
  const logId = log.rows[0].id;
  const startedAt = Date.now();
  const stats = { fetched: 0, new: 0, skipped: 0, failed: 0 };
  let timedOut = false;

  try {
    console.log(`[BACKFILL] Historical SEC backfill ${START_YEAR}–${END_YEAR}`);
    console.log(`[BACKFILL] Forms: ${FILING_TYPES.join(', ')}`);

    // Year-first ordering prevents one filing form from monopolizing the entire
    // time budget and gives each period coverage across all transaction forms.
    outer:
    for (let year = END_YEAR; year >= START_YEAR; year--) {
      for (const filingType of FILING_TYPES) {
        if (Date.now() - startedAt >= TIME_LIMIT_MS) {
          timedOut = true;
          break outer;
        }
        try {
          const filings = await fetchFilingsForPeriod(filingType, `${year}-01-01`, `${year}-12-31`);
          stats.fetched += filings.length;
          console.log(`[BACKFILL] ${year} ${filingType}: ${filings.length} filings`);

          for (const filing of filings) {
            if (Date.now() - startedAt >= TIME_LIMIT_MS) {
              timedOut = true;
              break outer;
            }
            try {
              const result = await processFiling(filing, filingType);
              if (result === 'new') {
                stats.new++;
                await sleep(DELAY_MS);
              } else {
                stats.skipped++;
              }
            } catch (error) {
              stats.failed++;
              console.error(`[BACKFILL] ${filingType} ${cleanAccession(filing.id)} failed:`, error.message);
            }
          }
        } catch (error) {
          stats.failed++;
          console.error(`[BACKFILL] ${filingType} ${year} query failed:`, error.message);
        }
        await sleep(300);
      }
    }

    await db.query(`UPDATE ingestion_log SET run_ended_at=NOW(),records_fetched=$2,records_new=$3,records_failed=$4,status='success',metadata=$5::jsonb,duration_ms=EXTRACT(EPOCH FROM (NOW()-run_started_at))*1000 WHERE id=$1`, [logId, stats.fetched, stats.new, stats.failed, JSON.stringify({ skipped: stats.skipped, timedOut, startYear: START_YEAR, endYear: END_YEAR })]);
    console.log(`[BACKFILL] ${timedOut ? 'Time budget reached' : 'Complete'}:`, stats);
    return { ...stats, timedOut };
  } catch (error) {
    await db.query(`UPDATE ingestion_log SET run_ended_at=NOW(),status='failed',records_fetched=$2,records_new=$3,records_failed=$4,error_message=$5 WHERE id=$1`, [logId, stats.fetched, stats.new, stats.failed + 1, error.message]).catch(() => {});
    throw error;
  }
}

async function ensureIngestionSchema() {
  const candidates = [
    path.join(__dirname, 'FIX-ingestion-quality-migration.sql'),
    path.join(__dirname, '../database/migrations/20260611_ingestion_quality.sql'),
    path.join(__dirname, 'database/migrations/20260611_ingestion_quality.sql'),
  ];
  const migrationPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!migrationPath) throw new Error('Ingestion quality migration file not found');
  await db.query(fs.readFileSync(migrationPath, 'utf8'));
}

function dateOnly(value) {
  return new Date(`${value}T00:00:00Z`);
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchFilingsForPeriod(filingType, startdt, enddt, depth = 0) {
  const first = await fetchEftsPage(filingType, startdt, enddt, 0);
  const total = Number(first?.hits?.total?.value || 0);

  if (total >= 10000) {
    const start = dateOnly(startdt);
    const end = dateOnly(enddt);
    const days = Math.floor((end - start) / 86400000);
    if (days < 1 || depth >= 12) throw new Error(`SEC EFTS range remains >=10k results at ${startdt}..${enddt}`);
    const mid = new Date(start.getTime() + Math.floor(days / 2) * 86400000);
    const rightStart = new Date(mid.getTime() + 86400000);
    const [left, right] = await Promise.all([
      fetchFilingsForPeriod(filingType, startdt, isoDate(mid), depth + 1),
      fetchFilingsForPeriod(filingType, isoDate(rightStart), enddt, depth + 1),
    ]);
    return dedupeFilings([...left, ...right]);
  }

  const all = [];
  let from = 0;
  const size = 100;
  let page = first;
  while (true) {
    const hits = page?.hits?.hits || [];
    for (const hit of hits) all.push(hitToFiling(hit));
    from += size;
    if (!hits.length || from >= total) break;
    await sleep(350);
    page = await fetchEftsPage(filingType, startdt, enddt, from);
  }
  return dedupeFilings(all);
}

async function fetchEftsPage(filingType, startdt, enddt, from) {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(filingType)}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}&size=100&hits.hits.total.value=true`;
  return fetchJson(url);
}

function hitToFiling(hit) {
  const cik = hit._source?.entity_id || extractCIK(hit._id);
  return {
    id: hit._id,
    entity_name: hit._source?.entity_name || hit._source?.display_names?.[0] || 'Unknown',
    cik,
    filing_date: hit._source?.file_date || hit._source?.period_of_report,
    filing_url: buildEdgarUrl(hit._id, cik),
  };
}

function dedupeFilings(items) {
  const map = new Map();
  for (const item of items) {
    const accession = cleanAccession(item.id);
    if (accession && !map.has(accession)) map.set(accession, item);
  }
  return [...map.values()];
}

function isFilingAgent(name) {
  return name ? FILING_AGENT_PATTERNS.some(pattern => pattern.test(name)) : false;
}

async function processFiling(filing, filingType) {
  if (isFilingAgent(filing.entity_name)) return 'skip';
  const accession = cleanAccession(filing.id);
  if (!accession) return 'skip';

  const existing = await db.query('SELECT id FROM filings WHERE accession_no=$1 LIMIT 1', [accession]);
  if (existing.rows.length) return 'skip';

  const detail = await fetchFilingDetail(filing.cik, filing.id);
  const documentUrl = detail?.document_url || filing.filing_url || '';
  const rawHtml = await fetchFilingText(documentUrl);
  const docText = stripHtml(rawHtml || '');
  const dealInfo = extractDealInfo(filing, detail, filingType, docText);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mawire:sec-accession:${accession}`]);
    const duplicate = await client.query('SELECT id FROM filings WHERE accession_no=$1 LIMIT 1', [accession]);
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      return 'skip';
    }

    const acquirer = await upsertCompany(client, dealInfo.acquirer, dealInfo.acquirer_is_filer ? filing.cik : null);
    const target = await upsertCompany(client, dealInfo.target, dealInfo.target_is_filer ? filing.cik : null);
    const dealId = await insertDeal(client, { ...dealInfo, acquirer_id: acquirer?.id || null, target_id: target?.id || null });

    await client.query(`INSERT INTO filings(deal_id,company_id,filing_type,document_url,edgar_url,accession_no,cik,filing_date,processed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`, [
      dealId,
      (dealInfo.target_is_filer ? target?.id : acquirer?.id) || null,
      filingType,
      trunc(documentUrl, 500),
      trunc(filing.filing_url, 500),
      trunc(accession, 30),
      filing.cik || null,
      filing.filing_date || null,
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

function cleanAccession(value) {
  return String(value || '').split(':')[0].trim();
}

async function fetchFilingDetail(cik, accessionNo) {
  try {
    if (!cik || !accessionNo) return null;
    const accession = cleanAccession(accessionNo);
    const cleanDigits = accession.replace(/-/g, '');
    const data = await fetchJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`);
    const recent = data?.filings?.recent;
    if (!recent) return { company_name: data?.name, sic: data?.sic };
    const index = recent.accessionNumber?.findIndex(item => String(item).replace(/-/g, '') === cleanDigits);
    if (index === undefined || index < 0) return { company_name: data.name, sic: data.sic };
    const primary = recent.primaryDocument?.[index] || '';
    return {
      company_name: data.name,
      sic: data.sic,
      document_url: primary ? `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanDigits}/${primary}` : null,
    };
  } catch (error) {
    console.warn('[BACKFILL] filing detail unavailable:', error.message);
    return null;
  }
}

async function fetchFilingText(documentUrl) {
  if (!documentUrl) return '';
  try {
    return await fetchText(documentUrl, 250000);
  } catch (error) {
    console.warn('[BACKFILL] filing text unavailable:', error.message);
    return '';
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanParty(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  return isReliableName(name) && name.length <= 120 ? name : null;
}

function extractOtherParty(text, filingType) {
  if (!text || text.length < 100) return null;
  const patterns = [];
  if (['DEFM14A', 'PREM14A', 'DEFA14A', 'SC 13E-3', 'SC 13E-3/A'].includes(filingType)) {
    patterns.push(
      /to\s+be\s+acquired\s+by\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /acquisition\s+by\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /(?:parent|buyer|acquiror|acquirer|offeror)\s+(?:is|means|:)\s*([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i
    );
  }
  if (['SC TO-T', 'SC TO-T/A'].includes(filingType)) {
    patterns.push(
      /Offer\s+to\s+Purchase\s+(?:All\s+)?(?:Outstanding\s+)?(?:Shares|Stock)\s+of\s+(?:Common\s+Stock\s+of\s+)?([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /(?:acquire|purchase)\s+(?:all\s+)?(?:outstanding\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i
    );
  }
  if (['S-4', 'S-4/A'].includes(filingType)) {
    patterns.push(/merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i);
  }
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = cleanParty(match?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractDealValueCents(text) {
  const candidates = [];
  const patterns = [
    { re: /(?:aggregate|total|transaction)\s+(?:consideration|value)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*billion/gi, multiplier: 1e9 },
    { re: /(?:aggregate|total|transaction)\s+(?:consideration|value)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*million/gi, multiplier: 1e6 },
  ];
  for (const { re, multiplier } of patterns) {
    let match;
    while ((match = re.exec(text || '')) !== null) {
      const dollars = Number.parseFloat(match[1].replace(/,/g, '')) * multiplier;
      if (Number.isFinite(dollars) && dollars >= 1e6) candidates.push(dollars);
    }
  }
  return candidates.length ? Math.round(Math.max(...candidates) * 100) : null;
}

function extractDealInfo(filing, detail, filingType, docText) {
  const filer = cleanParty(!isFilingAgent(filing.entity_name) ? filing.entity_name : detail?.company_name);
  const other = extractOtherParty(docText, filingType);
  const generic = extractParties(docText || '');
  let acquirer = null;
  let target = null;
  let dealType = 'Merger';
  let acquirerIsFiler = false;
  let targetIsFiler = false;

  if (['DEFM14A', 'PREM14A', 'DEFA14A'].includes(filingType)) {
    target = filer;
    acquirer = cleanParty(firstReliable(other, generic.acquirer));
    targetIsFiler = true;
  } else if (['SC TO-T', 'SC TO-T/A'].includes(filingType)) {
    acquirer = filer;
    target = cleanParty(firstReliable(other, generic.target));
    acquirerIsFiler = true;
    dealType = 'Tender Offer';
  } else if (['S-4', 'S-4/A'].includes(filingType)) {
    acquirer = filer;
    target = cleanParty(firstReliable(other, generic.target));
    acquirerIsFiler = true;
  } else if (['SC 13E-3', 'SC 13E-3/A'].includes(filingType)) {
    // The issuer/filer is the subject company. Never manufacture a same-party
    // acquirer; the buyer/parent must be evidenced separately.
    target = filer;
    acquirer = cleanParty(firstReliable(other, generic.acquirer));
    if (normalizeName(acquirer) === normalizeName(target)) acquirer = null;
    targetIsFiler = true;
    dealType = 'Going-Private';
  }

  const distinct = acquirer && target && normalizeName(acquirer) !== normalizeName(target);
  const confidence = distinct ? 0.8 : 0.7;
  return {
    headline: `${acquirer || 'Unknown acquirer'} / ${target || 'Unknown target'}`,
    acquirer: acquirer ? { name: acquirer } : null,
    target: target ? { name: target } : null,
    extracted_acquirer_name: acquirer,
    extracted_target_name: target,
    raw_extracted_snippet: rawSnippet(docText),
    acquirer_is_filer: acquirerIsFiler,
    target_is_filer: targetIsFiler,
    deal_type: dealType,
    deal_value_cents: extractDealValueCents(docText),
    status: 'Announced',
    filing_date: filing.filing_date,
    announcement_date: filing.filing_date,
    source_url: filing.filing_url,
    sector: sicToSector(detail?.sic),
    source_confidence: confidence,
    needs_review: !distinct,
  };
}

async function upsertCompany(client, info, cik) {
  if (!info || !isReliableName(info.name)) return null;
  const normalized = normalizeName(info.name);
  if (!normalized) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mawire:company:${normalized}`]);

  if (cik) {
    const byCik = await client.query('SELECT id,normalized_name FROM companies WHERE cik=$1 LIMIT 1', [String(cik)]);
    if (byCik.rows[0]?.normalized_name === normalized) return byCik.rows[0];
  }
  const byName = await client.query('SELECT id FROM companies WHERE normalized_name=$1 ORDER BY created_at,id LIMIT 1', [normalized]);
  if (byName.rows[0]) return byName.rows[0];
  const inserted = await client.query('INSERT INTO companies(name,normalized_name,cik) VALUES($1,$2,$3) RETURNING id', [trunc(info.name, 500), trunc(normalized, 500), cik ? String(cik) : null]);
  return inserted.rows[0];
}

async function insertDeal(client, info) {
  const result = await client.query(`INSERT INTO deals(acquirer_id,target_id,headline,deal_type,status,announcement_date,filing_date,sector,deal_value,source_confidence,extraction_method,needs_review,extracted_acquirer_name,extracted_target_name,raw_extracted_snippet) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sec_filing',$11,$12,$13,$14) RETURNING id`, [
    info.acquirer_id,
    info.target_id,
    info.headline,
    info.deal_type,
    info.status,
    info.announcement_date || null,
    info.filing_date || null,
    info.sector || null,
    info.deal_value_cents || null,
    info.source_confidence || 0.7,
    Boolean(info.needs_review),
    trunc(info.extracted_acquirer_name, 500),
    trunc(info.extracted_target_name, 500),
    info.raw_extracted_snippet,
  ]);
  await client.query(`INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,confidence) VALUES($1,'sec_edgar','SEC EDGAR',$2,$3,$4) ON CONFLICT DO NOTHING`, [result.rows[0].id, trunc(info.source_url, 500), info.filing_date || null, info.source_confidence || 0.7]);
  return result.rows[0].id;
}

function trunc(value, length) { return value ? String(value).slice(0, length) : value; }
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ').replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function sicToSector(sic) {
  const value = Number.parseInt(sic, 10);
  if (!Number.isFinite(value)) return null;
  if (value >= 100 && value <= 999) return 'Agriculture';
  if (value >= 1000 && value <= 1499) return 'Mining';
  if (value >= 1500 && value <= 1799) return 'Construction';
  if (value >= 2000 && value <= 3999) return 'Manufacturing';
  if (value >= 4000 && value <= 4999) return 'Transportation';
  if (value >= 5000 && value <= 5199) return 'Wholesale';
  if (value >= 5200 && value <= 5999) return 'Consumer';
  if (value >= 6000 && value <= 6799) return 'Financial Services';
  if (value >= 7000 && value <= 7999) return 'Services';
  if (value >= 8000 && value <= 8099) return 'Healthcare';
  if (value >= 8700 && value <= 8999) return 'Technology';
  if (value >= 9000) return 'Government';
  return null;
}

function extractCIK(id) {
  const match = String(id || '').match(/^(\d{10})-\d{2}-\d{6}/);
  return match ? Number.parseInt(match[1], 10).toString() : '';
}
function buildEdgarUrl(hitId, cik) {
  const parts = String(hitId || '').split(':');
  const accession = parts[0];
  const filename = parts[1] || '';
  const folder = accession.replace(/-/g, '');
  if (!cik || !folder) return null;
  return filename ? `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${filename}` : `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function request(url, accept, maxBytes, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('SEC redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url).toString(), accept, maxBytes, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`SEC HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) return req.destroy(new Error(`SEC response exceeded ${maxBytes} bytes`));
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`SEC timeout: ${url}`)));
  });
}

async function fetchJson(url) {
  const text = await request(url, 'application/json', 20 * 1024 * 1024);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid SEC JSON from ${url}`); }
}
async function fetchText(url, maxBytes) {
  return request(url, 'text/html,text/plain,*/*', maxBytes);
}

module.exports = { run, ensureIngestionSchema, cleanAccession, fetchFilingsForPeriod, extractDealInfo, extractDealValueCents };

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      console.error('[BACKFILL] Fatal:', error.stack || error);
      process.exitCode = 1;
      await db.end().catch(() => {});
    });
}
