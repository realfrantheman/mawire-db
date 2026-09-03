/**
 * mergers.news — SEC EDGAR live ingestion service
 * Runs repeatedly under scheduler.js. Filing persistence is atomic and
 * accession-idempotent; going-private filings never manufacture a same-party
 * buyer/target pair.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const sharedExtractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractParties, firstReliable, isReliableName, rawSnippet, withRetry } = require(sharedExtractionPath);

const CONFIG = {
  db_url: process.env.DATABASE_URL,
  filing_types: ['DEFM14A', 'PREM14A', 'DEFA14A', 'SC TO-T', 'SC TO-T/A', 'S-4', 'S-4/A', 'SC 13E-3', 'SC 13E-3/A'],
  lookback_days: Number.parseInt(process.env.LOOKBACK_DAYS || '2', 10),
};
if (!CONFIG.db_url) throw new Error('DATABASE_URL is required');

const db = new Pool({
  connectionString: CONFIG.db_url,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 8,
  statement_timeout: 120000,
});
db.on('error', error => console.error('[SEC] idle database client error:', error.message));

const USER_AGENT = 'mergers.news contact@mergers.news';
const FILING_AGENT_PATTERNS = [/\/FA$/i, /- FA$/i, /EDGARFILINGS/i, /FILING SERVICES/i, /FILING AGENT/i, /DONNELLEY\s+FINANCIAL/i, /^BCP INVESTMENT CORP\b/i];

async function run() {
  const logId = await startLog('sec_edgar');
  const stats = { fetched: 0, new: 0, updated: 0, failed: 0 };
  let sourceFailures = 0;

  try {
    console.log('[SEC] Starting ingestion run at', new Date().toISOString());
    for (const filingType of CONFIG.filing_types) {
      try {
        const filings = await fetchRecentFilings(filingType);
        stats.fetched += filings.length;
        console.log(`[SEC] ${filingType}: ${filings.length} filings`);
        for (const filing of filings) {
          try {
            const result = await processFiling(filing, filingType);
            if (result === 'new') stats.new++;
            if (result === 'updated') stats.updated++;
          } catch (error) {
            stats.failed++;
            console.error(`[SEC] Filing ${cleanAccession(filing.id)} failed:`, error.message);
          }
        }
      } catch (error) {
        sourceFailures++;
        stats.failed++;
        console.error(`[SEC] ${filingType} fetch failed:`, error.message);
      }
    }

    const excessiveRecordFailures = stats.fetched > 0 && stats.failed > Math.max(5, Math.ceil(stats.fetched * 0.2));
    if (sourceFailures > 0 || excessiveRecordFailures) {
      throw new Error(`Incomplete SEC run: ${sourceFailures} form fetch failures, ${stats.failed} record failures`);
    }

    await endLog(logId, 'success', stats);
    console.log('[SEC] Run complete:', stats);
    return stats;
  } catch (error) {
    await endLog(logId, 'failed', stats, error.message).catch(() => {});
    console.error('[SEC] Fatal:', error.stack || error.message);
    throw error;
  }
}

function buildEftsUrl(filingType, startdt, enddt, from = 0) {
  return `https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(filingType)}&dateRange=custom&startdt=${encodeURIComponent(startdt)}&enddt=${encodeURIComponent(enddt)}&from=${from}&size=100&hits.hits.total.value=true`;
}

async function fetchRecentFilings(filingType) {
  const endDate = new Date();
  const fromDate = new Date(endDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - CONFIG.lookback_days);
  const startdt = fromDate.toISOString().slice(0, 10);
  const enddt = endDate.toISOString().slice(0, 10);
  const results = [];
  let from = 0;

  while (true) {
    const url = buildEftsUrl(filingType, startdt, enddt, from);
    const data = await withRetry(() => fetchJson(url), { attempts: 4, baseDelayMs: 1000 });
    const hits = data?.hits?.hits;
    if (!Array.isArray(hits)) throw new Error('SEC EFTS response missing hits array');
    for (const hit of hits) {
      const exactForm = String(hit?._source?.form || '').trim();
      if (exactForm && exactForm !== filingType) continue;
      results.push(hitToFiling(hit));
    }
    from += hits.length;
    const total = Number(data?.hits?.total?.value || 0);
    if (!hits.length || from >= total) break;
    if (from >= 10000) throw new Error(`SEC EFTS returned >=10,000 ${filingType} filings between ${startdt} and ${enddt}; reduce LOOKBACK_DAYS`);
    await sleep(300);
  }
  return dedupeFilings(results);
}

function cleanDisplayName(value) {
  return String(value || '')
    .replace(/\s+\([^)]*\)\s+\(CIK\s+\d+\)\s*$/i, '')
    .replace(/\s+\(CIK\s+\d+\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hitToFiling(hit) {
  const source = hit?._source || {};
  const primaryCik = Array.isArray(source.ciks) ? source.ciks[0] : null;
  const cikDigits = String(primaryCik || source.entity_id || '').replace(/\D/g, '');
  const cik = cikDigits ? String(Number.parseInt(cikDigits, 10)) : extractCIK(hit?._id);
  const displayName = Array.isArray(source.display_names) ? source.display_names[0] : source.entity_name;
  return {
    id: hit?._id,
    accession_no: cleanAccession(hit?._id),
    entity_name: cleanDisplayName(displayName) || 'Unknown',
    cik,
    filing_date: source.file_date || source.period_ending || source.period_of_report || null,
    filing_url: buildEdgarUrl(hit?._id, cik),
    raw: source,
  };
}

function dedupeFilings(items) {
  const map = new Map();
  for (const item of items) {
    if (item.accession_no && !map.has(item.accession_no)) map.set(item.accession_no, item);
  }
  return [...map.values()];
}

function cleanAccession(value) {
  return String(value || '').split(':')[0].trim();
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
  return filename
    ? `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${filename}`
    : `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/`;
}

function isFilingAgent(name) {
  return name ? FILING_AGENT_PATTERNS.some(pattern => pattern.test(name)) : false;
}

async function processFiling(filing, filingType) {
  if (isFilingAgent(filing.entity_name)) return 'skip';
  const accession = cleanAccession(filing.id);
  if (!accession) return 'skip';

  const known = await db.query('SELECT id FROM filings WHERE accession_no=$1 LIMIT 1', [accession]);
  if (known.rows.length) return 'skip';

  const detail = await fetchFilingDetail(filing.cik, accession);
  const documentUrl = detail?.document_url || filing.filing_url || '';
  const rawHtml = await fetchFilingText(documentUrl);
  const docText = stripHtml(rawHtml);
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
    const dealId = await insertDeal(client, {
      ...dealInfo,
      acquirer_id: acquirer?.id || null,
      target_id: target?.id || null,
      extraction_method: 'sec_filing',
      source_url: documentUrl || filing.filing_url,
    });

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

async function fetchFilingDetail(cik, accessionNo) {
  try {
    if (!cik || !accessionNo) return null;
    const cleanDigits = cleanAccession(accessionNo).replace(/-/g, '');
    const data = await withRetry(() => fetchJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`), { attempts: 3, baseDelayMs: 800 });
    const recent = data?.filings?.recent;
    if (!recent) return { company_name: data?.name, sic: data?.sic };
    const index = recent.accessionNumber?.findIndex(item => String(item).replace(/-/g, '') === cleanDigits);
    if (index === undefined || index < 0) return { company_name: data.name, sic: data.sic };
    const primary = recent.primaryDocument?.[index] || '';
    return {
      company_name: data.name,
      sic: data.sic,
      document_url: primary ? `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanDigits}/${primary}` : null,
      period: recent.reportDate?.[index],
      description: recent.primaryDocDescription?.[index],
    };
  } catch (error) {
    console.warn(`[SEC] Filing detail unavailable for ${accessionNo}:`, error.message);
    return null;
  }
}

async function fetchFilingText(documentUrl) {
  if (!documentUrl) return '';
  try {
    return await withRetry(() => fetchText(documentUrl, 2 * 1024 * 1024), { attempts: 2, baseDelayMs: 600 });
  } catch (error) {
    console.warn('[SEC] Filing text unavailable:', error.message);
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
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
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
      /(?:acquire|purchase)\s+(?:all\s+)?(?:outstanding\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /tender\s+offer\s+for\s+(?:all\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i
    );
  }
  if (['S-4', 'S-4/A'].includes(filingType)) {
    patterns.push(
      /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i,
      /acquisition\s+of\s+([A-Z][A-Za-z0-9\s,.&'-]{2,80})/i
    );
  }

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = cleanParty(match?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractDealValueCents(text) {
  if (!text) return null;
  const candidates = [];
  const specs = [
    { patterns: [/(?:aggregate|total|transaction|deal|merger)\s+(?:consideration|value|proceeds)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*billion/gi, /\$\s*([\d,]+(?:\.\d+)?)\s*billion\s+(?:in\s+)?(?:cash\s+)?(?:consideration|merger|acquisition|transaction)/gi], multiplier: 1e9 },
    { patterns: [/(?:aggregate|total|transaction|deal|merger)\s+(?:consideration|value|proceeds)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*million/gi, /\$\s*([\d,]+(?:\.\d+)?)\s*million\s+(?:in\s+)?(?:cash\s+)?(?:consideration|merger|acquisition|transaction)/gi], multiplier: 1e6 },
  ];
  for (const spec of specs) {
    for (const pattern of spec.patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const dollars = Number.parseFloat(match[1].replace(/,/g, '')) * spec.multiplier;
        if (Number.isFinite(dollars) && dollars >= 1e6 && dollars < 1e15) candidates.push(dollars);
      }
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
    target = filer;
    acquirer = cleanParty(firstReliable(other, generic.acquirer));
    if (normalizeName(acquirer) === normalizeName(target)) acquirer = null;
    targetIsFiler = true;
    dealType = 'Going-Private';
  }

  const distinct = !!acquirer && !!target && normalizeName(acquirer) !== normalizeName(target);
  const evidenceConfidence = Number(generic.confidence || 0.45);
  const confidence = distinct ? Math.max(0.8, Math.min(0.9, evidenceConfidence)) : Math.min(0.7, evidenceConfidence || 0.45);

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
    filing_type: filingType,
    filing_date: filing.filing_date,
    announcement_date: filing.filing_date,
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
  const result = await client.query(`INSERT INTO deals(acquirer_id,target_id,headline,deal_type,status,announcement_date,filing_date,sector,deal_value,source_confidence,extraction_method,needs_review,extracted_acquirer_name,extracted_target_name,raw_extracted_snippet) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [
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
    info.extraction_method || 'sec_filing',
    Boolean(info.needs_review),
    trunc(info.extracted_acquirer_name, 500),
    trunc(info.extracted_target_name, 500),
    info.raw_extracted_snippet,
  ]);
  await client.query(`INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,raw_content,confidence) VALUES($1,'sec_edgar','SEC EDGAR',$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [result.rows[0].id, trunc(info.source_url, 500), info.filing_date || null, info.raw_extracted_snippet, info.source_confidence]);
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
async function fetchText(url, maxBytes) { return request(url, 'text/html,text/plain,*/*', maxBytes); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startLog(source) {
  const result = await db.query(`INSERT INTO ingestion_log(source,run_started_at,status) VALUES($1,NOW(),'running') RETURNING id`, [source]);
  return result.rows[0].id;
}
async function endLog(id, status, stats, error) {
  await db.query(`UPDATE ingestion_log SET run_ended_at=NOW(),status=$1,records_fetched=$2,records_new=$3,records_updated=$4,records_failed=$5,error_message=$6,duration_ms=EXTRACT(EPOCH FROM (NOW()-run_started_at))*1000 WHERE id=$7`, [status, stats.fetched, stats.new, stats.updated, stats.failed, error || null, id]);
}

module.exports = { run, cleanAccession, buildEftsUrl, cleanDisplayName, hitToFiling, fetchRecentFilings, extractDealInfo, extractOtherParty, extractDealValueCents };

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      console.error(error.stack || error);
      process.exitCode = 1;
      await db.end().catch(() => {});
    });
}
