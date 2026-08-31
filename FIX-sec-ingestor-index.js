/**
 * mergers.news — SEC EDGAR Ingestion Service
 * Runs every 30 minutes via cron
 * Fetches DEFM14A, SC TO-T, S-4, SC 13E-3 filings
 * Stores deal records to PostgreSQL
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { Pool } = require('pg');
const sharedExtractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractParties, firstReliable, isReliableName, rawSnippet, withRetry } = require(sharedExtractionPath);

// ── CONFIG ────────────────────────────────────────────────────────
const CONFIG = {
  db_url:        process.env.DATABASE_URL,
  batch_size:    100,
  filing_types: ['DEFM14A', 'SC TO-T', 'S-4', 'SC 13E-3', 'DEFA14A', 'SC TO-T/A'],
  lookback_days: parseInt(process.env.LOOKBACK_DAYS || '2', 10),
};

const db = new Pool({ connectionString: CONFIG.db_url, ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true } });

// ── MAIN ──────────────────────────────────────────────────────────
async function run() {
  const logId = await startLog('sec_edgar');
  const stats  = { fetched: 0, new: 0, updated: 0, failed: 0 };

  try {
    console.log('[SEC] Starting ingestion run at', new Date().toISOString());

    for (const filingType of CONFIG.filing_types) {
      console.log(`[SEC] Processing filing type: ${filingType}`);
      try {
        const filings = await fetchRecentFilings(filingType);
        stats.fetched += filings.length;
        console.log(`[SEC] Found ${filings.length} ${filingType} filings`);

        for (const filing of filings) {
          try {
            const result = await processFiling(filing, filingType);
            if (result === 'new')     stats.new++;
            if (result === 'updated') stats.updated++;
          } catch (err) {
            stats.failed++;
            console.error(`[SEC] Error processing filing ${filing.id}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[SEC] Error fetching ${filingType}:`, err.message);
        stats.failed++;
      }
    }

    await endLog(logId, 'success', stats);
    console.log('[SEC] Run complete:', stats);
  } catch (err) {
    await endLog(logId, 'failed', stats, err.message);
    console.error('[SEC] Fatal error:', err);
    // do not call process.exit — keep the scheduler alive
  }
  // do not call db.end() — pool is reused across cron ticks
}

// ── FETCH RECENT FILINGS FROM EDGAR FULL-TEXT SEARCH ─────────────
async function fetchRecentFilings(filingType) {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - CONFIG.lookback_days);
  const dateStr  = dateFrom.toISOString().split('T')[0];

  const data = await withRetry(
    () => fetchJson(`https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(filingType)}&dateRange=custom&startdt=${dateStr}`),
    { attempts: 4, baseDelayMs: 1000 }
  );

  if (!data || !data.hits || !data.hits.hits) return [];

  return data.hits.hits.map(hit => {
    const cik = hit._source?.entity_id || extractCIK(hit._id);
    return {
      id:           hit._id,
      accession_no: hit._source?.period_of_report,
      entity_name:  hit._source?.entity_name || hit._source?.display_names?.[0] || 'Unknown',
      cik,
      filing_date:  hit._source?.period_of_report || hit._source?.file_date,
      filing_url:   buildEdgarUrl(hit._id, cik),
      document_url: hit._source?.file_date,
      raw:          hit._source,
    };
  });
}

// EDGAR EFTS hit._id format: "{CIK10d}-{YY}-{SEQNO}:{FILENAME}"
// e.g. "0001104659-26-071582:tm2617193d1_defa14a.htm"
function extractCIK(id) {
  if (!id) return '';
  const m = String(id).match(/^(\d{10})-\d{2}-\d{6}/);
  if (m) return parseInt(m[1], 10).toString(); // strip leading zeros
  return '';
}

function buildEdgarUrl(hitId, cik) {
  const parts     = String(hitId || '').split(':');
  const accession = parts[0]; // "0001104659-26-071582"
  const filename  = parts[1] || '';
  const folder    = accession.replace(/-/g, ''); // "000110465926071582"
  if (!cik || !folder) return null;
  return filename
    ? `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${filename}`
    : `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/`;
}

// Known filing agents whose names appear as EDGAR entity_name but are not deal parties
const FILING_AGENT_PATTERNS = [
  /\/FA$/i, /- FA$/i,           // e.g. "MERRILL CORP /NEW/ - FA", "Toppan Merrill/FA"
  /EDGARFILINGS/i,
  /FILING SERVICES/i,
  /FILING AGENT/i,
  /DONNELLEY\s+FINANCIAL/i,
  /^BCP INVESTMENT CORP\b/i,
];

function isFilingAgent(entityName) {
  if (!entityName) return false;
  return FILING_AGENT_PATTERNS.some(p => p.test(entityName));
}

// ── PROCESS A SINGLE FILING ────────────────────────────────────────
async function processFiling(filing, filingType) {
  // Skip known filing agents masquerading as deal entities
  if (isFilingAgent(filing.entity_name)) {
    console.log(`[SEC] Skip filing agent entity: ${filing.entity_name}`);
    return 'skip';
  }

  // Check if already processed — compare using clean accession (no colon/filename suffix)
  const cleanAcc = filing.id.split(':')[0];
  const existing = await db.query(
    'SELECT id FROM filings WHERE accession_no = $1',
    [cleanAcc]
  );
  if (existing.rows.length > 0) return 'skip';

  // Fetch filing detail from EDGAR
  const detail = await fetchFilingDetail(filing.cik, filing.id);

  // Fetch document text for party + value extraction (best-effort, 15s timeout)
  const rawHtml = await fetchFilingText(detail?.document_url || '');
  const docText = rawHtml ? stripHtml(rawHtml) : '';

  // Extract deal info
  const dealInfo = extractDealInfo(filing, detail, filingType, docText);

  // Upsert company records
  const acquirerResult = await upsertCompany(dealInfo.acquirer, dealInfo.acquirer_is_filer ? filing.cik : null);
  const targetResult   = await upsertCompany(dealInfo.target, dealInfo.target_is_filer ? filing.cik : null);

  // Insert deal record
  const dealId = await insertDeal({
    ...dealInfo,
    acquirer_id:       acquirerResult?.id || null,
    target_id:         targetResult?.id,
    extraction_method: 'sec_filing',
  });

  // Insert filing record
  await db.query(`
    INSERT INTO filings (deal_id, company_id, filing_type, document_url, edgar_url,
                         accession_no, cik, filing_date, processed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
  `, [
    dealId,
    (dealInfo.target_is_filer ? targetResult?.id : acquirerResult?.id) || null,
    filingType,
    trunc(detail?.document_url || filing.filing_url, 500),
    trunc(filing.filing_url, 500),
    trunc(filing.id.split(':')[0], 30),  // store clean accession "0001234567-26-000076", not truncated hit._id
    filing.cik,
    filing.filing_date,
  ]);

  return 'new';
}

// ── FETCH FILING DETAIL ───────────────────────────────────────────
async function fetchFilingDetail(cik, accessionNo) {
  try {
    if (!cik || !accessionNo) return null;
    const cleanAccession = String(accessionNo).split(':')[0].replace(/-/g, '');
    const url = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10,'0')}.json`;
    const data = await fetchJson(url);
    if (!data) return null;

    // Find this specific filing
    const filings  = data.filings?.recent;
    if (!filings)  return null;
    const idx = filings.accessionNumber?.findIndex(a => a.replace(/-/g,'') === cleanAccession);
    if (idx === undefined || idx < 0) return { company_name: data.name, sic: data.sic };

    return {
      company_name:  data.name,
      sic:           data.sic,
      document_url:  `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanAccession}/${filings.primaryDocument?.[idx] || ''}`,
      period:        filings.reportDate?.[idx],
      description:   filings.primaryDocDescription?.[idx],
    };
  } catch (err) {
    return null;
  }
}

// ── FETCH FILING DOCUMENT TEXT (first 40KB) ───────────────────────
async function fetchFilingText(documentUrl) {
  if (!documentUrl) return '';
  try {
    return await new Promise((resolve) => {
      const client = documentUrl.startsWith('https') ? require('https') : require('http');
      const req = client.get(documentUrl, {
        headers: { 'User-Agent': 'mergers.news contact@mergers.news', 'Accept': 'text/html,text/plain' }
      }, res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.length > 40000) { req.destroy(); resolve(data.slice(0, 40000)); }
        });
        res.on('end', () => resolve(data.slice(0, 40000)));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(15000, () => { req.destroy(); resolve(''); });
    });
  } catch { return ''; }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── EXTRACT PARTY NAME FROM DOCUMENT TEXT ─────────────────────────
function extractOtherParty(text, filingType) {
  if (!text || text.length < 100) return null;

  // DEFM14A/DEFA14A: filer is the TARGET — extract ACQUIRER
  if (filingType === 'DEFM14A' || filingType === 'DEFA14A') {
    const acquirerPatterns = [
      /to\s+be\s+acquired\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?|Corporation|Company)?)/i,
      /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?|Corporation|Company)?)/i,
      /acquisition\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?|Corporation|Company)?)/i,
      /Agreement\s+and\s+Plan\s+of\s+Merger.{0,200}(?:and\s+)([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /PROPOSED\s+MERGER\s+WITH\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    ];
    for (const p of acquirerPatterns) {
      const m = text.match(p);
      if (m && m[1]) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (name.length >= 3 && name.length <= 80 && !/^(the|a|an|this|that)\b/i.test(name)) {
          return name;
        }
      }
    }
  }

  // SC TO-T / SC TO-T/A: filer is the ACQUIRER — extract TARGET
  if (filingType === 'SC TO-T' || filingType === 'SC TO-T/A') {
    const targetPatterns = [
      /Offer\s+to\s+Purchase\s+(?:All\s+)?(?:Outstanding\s+)?(?:Shares|Stock)\s+of\s+(?:Common\s+Stock\s+of\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /(?:acquire|purchase)\s+(?:all\s+)?(?:outstanding\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /tender\s+offer\s+for\s+(?:all\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    ];
    for (const p of targetPatterns) {
      const m = text.match(p);
      if (m && m[1]) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (name.length >= 3 && name.length <= 80 && !/^(the|a|an|all|any|each)\b/i.test(name)) {
          return name;
        }
      }
    }
  }

  // S-4: filer is acquirer — extract TARGET
  if (filingType === 'S-4') {
    const targetPatterns = [
      /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /acquisition\s+of\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    ];
    for (const p of targetPatterns) {
      const m = text.match(p);
      if (m && m[1]) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (name.length >= 3 && name.length <= 80) return name;
      }
    }
  }

  return null;
}

// ── EXTRACT DEAL VALUE FROM DOCUMENT TEXT ─────────────────────────
function extractDealValueCents(text) {
  if (!text) return null;
  const candidates = [];

  const billionPat = [
    /(?:aggregate|total|transaction|deal|merger)\s+(?:consideration|value|proceeds)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*billion/gi,
    /\$\s*([\d,]+(?:\.\d+)?)\s*billion\s+(?:in\s+)?(?:cash\s+)?(?:consideration|merger|acquisition|transaction)/gi,
  ];
  const millionPat = [
    /(?:aggregate|total|transaction|deal|merger)\s+(?:consideration|value|proceeds)\s+of\s+(?:approximately\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*million/gi,
    /\$\s*([\d,]+(?:\.\d+)?)\s*million\s+(?:in\s+)?(?:cash\s+)?(?:consideration|merger|acquisition|transaction)/gi,
  ];

  for (const p of billionPat) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, '')) * 1e9;
      if (!isNaN(v) && v >= 1e7 && v < 1e15) candidates.push(v);
    }
  }
  for (const p of millionPat) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, '')) * 1e6;
      if (!isNaN(v) && v >= 1e6 && v < 1e15) candidates.push(v);
    }
  }

  if (!candidates.length) return null;
  const best = Math.max(...candidates);
  return Math.round(best * 100); // store as cents
}

// ── EXTRACT DEAL INFO FROM FILING ─────────────────────────────────
function extractDealInfo(filing, detail, filingType, docText) {
  const companyName = !isFilingAgent(filing.entity_name) ? filing.entity_name : (detail?.company_name || 'Unknown');
  const otherParty  = extractOtherParty(docText, filingType);
  const generic      = extractParties(docText);
  const dealValueCents = extractDealValueCents(docText);

  let acquirer, target, dealType, status;

  switch (filingType) {
    case 'DEFM14A':
    case 'DEFA14A':
      target   = companyName;
      acquirer = firstReliable(otherParty, generic.acquirer);
      dealType = 'Merger';
      status   = 'Announced';
      break;
    case 'SC TO-T':
    case 'SC TO-T/A':
      acquirer = companyName;
      target   = firstReliable(otherParty, generic.target);
      dealType = 'Acquisition';
      status   = 'Announced';
      break;
    case 'S-4':
      acquirer = companyName;
      target   = firstReliable(otherParty, generic.target);
      dealType = 'Merger';
      status   = 'Announced';
      break;
    case 'SC 13E-3':
    case 'SC 13E-3/A':
      acquirer = companyName;
      target   = companyName;
      dealType = 'Going-Private';
      status   = 'Announced';
      break;
    default:
      acquirer = companyName;
      target   = firstReliable(otherParty, generic.target);
      dealType = 'Merger';
      status   = 'Announced';
  }

  return {
    headline:       `${acquirer || 'Unknown acquirer'} / ${target || 'Unknown target'}`,
    acquirer:       acquirer ? { name: acquirer, cik: filing.cik } : null,
    target:         target ? { name: target } : null,
    extracted_acquirer_name: acquirer,
    extracted_target_name: target,
    raw_extracted_snippet: rawSnippet(docText),
    acquirer_is_filer: filingType !== 'DEFM14A' && filingType !== 'DEFA14A',
    target_is_filer: filingType === 'DEFM14A' || filingType === 'DEFA14A',
    deal_type:      dealType,
    deal_value_cents: dealValueCents,
    status,
    filing_type:    filingType,
    filing_date:    filing.filing_date,
    announcement_date: filing.filing_date,
    source_url:     filing.filing_url,
    sector:         sicToSector(detail?.sic),
    source_confidence: otherParty ? 0.85 : (generic.confidence || 0.45),
    needs_review:   !isReliableName(acquirer) || !isReliableName(target),
  };
}

// ── COMPANY UPSERT ─────────────────────────────────────────────────
async function upsertCompany(info, cik) {
  if (!info || !isReliableName(info.name)) return null;

  const normalized = normalizeName(info.name);

  if (cik) {
    const byCik = await db.query('SELECT id, normalized_name FROM companies WHERE cik = $1', [cik]);
    if (byCik.rows.length && byCik.rows[0].normalized_name === normalized) return byCik.rows[0];
    if (byCik.rows.length) cik = null; // shared filing-agent CIK; never attach it to a different company
  }

  const byName = await db.query(
    'SELECT id FROM companies WHERE normalized_name = $1 LIMIT 1',
    [normalized]
  );
  if (byName.rows.length) return byName.rows[0];

  const res = await db.query(
    `INSERT INTO companies (name, normalized_name, cik)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [trunc(info.name, 500), trunc(normalized, 500), cik || null]
  );
  return res.rows[0];
}

// ── INSERT DEAL ────────────────────────────────────────────────────
async function insertDeal(info) {
  const res = await db.query(`
    INSERT INTO deals (
      acquirer_id, target_id, headline, deal_type, status,
      announcement_date, filing_date, sector, deal_value,
      source_confidence, extraction_method, needs_review,
      extracted_acquirer_name, extracted_target_name, raw_extracted_snippet
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id
  `, [
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

  const dealId = res.rows[0].id;

  await db.query(`
    INSERT INTO deal_sources (deal_id, source_type, source_name, source_url, source_date, raw_content, confidence)
    VALUES ($1, 'sec_edgar', 'SEC EDGAR', $2, $3, $4, $5)
  `, [dealId, trunc(info.source_url, 500), info.filing_date || null, info.raw_extracted_snippet, info.source_confidence]);

  return dealId;
}

// ── HELPERS ────────────────────────────────────────────────────────
function trunc(str, len) {
  return str ? String(str).slice(0, len) : str;
}

function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g, '')
    .trim();
}

function sicToSector(sic) {
  if (!sic) return null;
  const s = parseInt(sic);
  if (s >= 100  && s <= 999)  return 'Agriculture';
  if (s >= 1000 && s <= 1499) return 'Mining';
  if (s >= 1500 && s <= 1799) return 'Construction';
  if (s >= 2000 && s <= 3999) return 'Manufacturing';
  if (s >= 4000 && s <= 4999) return 'Transportation';
  if (s >= 5000 && s <= 5199) return 'Wholesale';
  if (s >= 5200 && s <= 5999) return 'Consumer';
  if (s >= 6000 && s <= 6799) return 'Financial Services';
  if (s >= 7000 && s <= 7999) return 'Services';
  if (s >= 8000 && s <= 8099) return 'Healthcare';
  if (s >= 8700 && s <= 8999) return 'Technology';
  if (s >= 9000)               return 'Government';
  return null;
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'mergers.news contact@mergers.news', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function startLog(source) {
  const res = await db.query(
    `INSERT INTO ingestion_log (source, run_started_at, status)
     VALUES ($1, NOW(), 'running') RETURNING id`,
    [source]
  );
  return res.rows[0].id;
}

async function endLog(id, status, stats, error) {
  await db.query(
    `UPDATE ingestion_log SET
       run_ended_at    = NOW(),
       status          = $1,
       records_fetched = $2,
       records_new     = $3,
       records_updated = $4,
       records_failed  = $5,
       error_message   = $6
     WHERE id = $7`,
    [status, stats.fetched, stats.new, stats.updated, stats.failed, error || null, id]
  );
}

// ── RUN ────────────────────────────────────────────────────────────
module.exports = { run, extractDealInfo, extractOtherParty, extractDealValueCents };

if (require.main === module) {
  run().then(() => db.end()).catch(e => { console.error(e); db.end(); process.exit(1); });
}
