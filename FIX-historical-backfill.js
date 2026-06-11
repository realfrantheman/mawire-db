/**
 * mergers.news — Historical M&A Backfill
 * Fetches ALL SEC EDGAR M&A filings from 1993 to today
 * Run once: node scripts/historical-backfill.js
 * Then let the scheduler handle ongoing ingestion
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const { Pool } = require('pg');
const { extractParties, firstReliable, isReliableName, rawSnippet } = require('../services/shared/deal-extraction');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const FILING_TYPES  = ['DEFM14A', 'SC TO-T', 'S-4', 'SC 13E-3', 'DEFA14A', 'SC TO-T/A', 'PREM14A', 'SC 13E-3/A'];
const START_YEAR    = parseInt(process.env.BACKFILL_START_YEAR || '1993', 10);
const END_YEAR      = parseInt(process.env.BACKFILL_END_YEAR   || String(new Date().getFullYear()), 10);
const DELAY_MS      = 400; // be polite to SEC servers
// Stop gracefully N minutes before the GHA timeout (default 100 min budget)
const TIME_LIMIT_MS = (parseInt(process.env.BACKFILL_TIME_LIMIT_MINUTES || '100', 10)) * 60 * 1000;

async function run() {
  await ensureIngestionSchema();
  const startedAt = Date.now();
  console.log(`[BACKFILL] Starting historical backfill ${START_YEAR}–${END_YEAR}`);
  console.log(`[BACKFILL] Filing types: ${FILING_TYPES.join(', ')}`);
  console.log(`[BACKFILL] Time limit: ${TIME_LIMIT_MS / 60000} min`);

  let totalNew = 0, totalSkipped = 0, totalFailed = 0;
  let timedOut = false;

  outer:
  for (const filingType of FILING_TYPES) {
    console.log(`\n[BACKFILL] === ${filingType} ===`);

    for (let year = END_YEAR; year >= START_YEAR; year--) {
      if (Date.now() - startedAt >= TIME_LIMIT_MS) {
        console.log(`[BACKFILL] Time limit reached at ${filingType} ${year} — stopping gracefully`);
        timedOut = true;
        break outer;
      }

      const startdt = `${year}-01-01`;
      const enddt   = `${year}-12-31`;

      try {
        const filings = await fetchFilingsForPeriod(filingType, startdt, enddt);
        console.log(`[BACKFILL] ${filingType} ${year}: ${filings.length} filings`);

        for (const filing of filings) {
          if (Date.now() - startedAt >= TIME_LIMIT_MS) {
            console.log(`[BACKFILL] Time limit reached mid-year — stopping gracefully`);
            timedOut = true;
            break outer;
          }
          try {
            const result = await processFiling(filing, filingType);
            if (result === 'new')  { totalNew++;     await sleep(DELAY_MS); }
            if (result === 'skip') { totalSkipped++; }
          } catch (err) {
            totalFailed++;
          }
        }
      } catch (err) {
        console.error(`[BACKFILL] ${filingType} ${year} error:`, err.message);
      }

      await sleep(300);
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n[BACKFILL] ${timedOut ? 'Stopped (time limit)' : 'Complete'}: ${totalNew} new, ${totalSkipped} skipped, ${totalFailed} failed — ${elapsed}s elapsed`);
  await db.end();
}

async function ensureIngestionSchema() {
  const migrationPaths = [
    'FIX-ingestion-quality-migration.sql',
    'database/migrations/20260611_ingestion_quality.sql',
  ];
  const migrationPath = migrationPaths.find(path => fs.existsSync(path));
  if (!migrationPath) throw new Error('Ingestion quality migration file not found');

  console.log(`[BACKFILL] Applying migration: ${migrationPath}`);
  await db.query(fs.readFileSync(migrationPath, 'utf8'));
  console.log('[BACKFILL] Ingestion quality migration complete');
}

async function fetchFilingsForPeriod(filingType, startdt, enddt) {
  const allFilings = [];
  let from = 0;
  const size = 100;

  while (true) {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(filingType)}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}&hits.hits.total.value=true`;
    const data = await fetchJson(url);
    if (!data || !data.hits || !data.hits.hits || !data.hits.hits.length) break;

    const hits = data.hits.hits;
    hits.forEach(hit => {
      const cik = hit._source?.entity_id || extractCIK(hit._id);
      allFilings.push({
        id:          hit._id,
        entity_name: hit._source?.entity_name || hit._source?.display_names?.[0] || 'Unknown',
        cik,
        filing_date: hit._source?.file_date   || hit._source?.period_of_report,
        filing_url:  buildEdgarUrl(hit._id, cik),
      });
    });

    const total = data.hits.total?.value || 0;
    from += size;
    if (from >= total || from >= 10000) break; // EDGAR caps at 10k per query
    await sleep(400);
  }

  return allFilings;
}

// Known filing agents — skip them (same filter as live ingestor)
const FILING_AGENT_PATTERNS = [/\/FA$/i, /- FA$/i, /EDGARFILINGS/i, /FILING SERVICES/i, /FILING AGENT/i, /DONNELLEY\s+FINANCIAL/i];
function isFilingAgent(name) { return name ? FILING_AGENT_PATTERNS.some(p => p.test(name)) : false; }

async function processFiling(filing, filingType) {
  if (isFilingAgent(filing.entity_name)) return 'skip';

  // Dedup check using clean accession (no colon+filename suffix)
  const cleanAcc = filing.id.split(':')[0];
  const existing = await db.query('SELECT id FROM filings WHERE accession_no = $1', [cleanAcc]);
  if (existing.rows.length > 0) return 'skip';

  const detail  = await fetchFilingDetail(filing.cik, filing.id);
  const rawHtml = await fetchFilingText(detail?.document_url || '');
  const docText = rawHtml ? stripHtml(rawHtml) : '';
  const dealInfo = extractDealInfo(filing, detail, filingType, docText);

  const acquirerResult = await upsertCompany(dealInfo.acquirer, dealInfo.acquirer_is_filer ? filing.cik : null);
  const targetResult   = await upsertCompany(dealInfo.target, dealInfo.target_is_filer ? filing.cik : null);

  const dealId = await insertDeal({
    ...dealInfo,
    acquirer_id: acquirerResult?.id || null,
    target_id:   targetResult?.id,
  });

  await db.query(`
    INSERT INTO filings (deal_id, company_id, filing_type, document_url, edgar_url, accession_no, cik, filing_date, processed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
  `, [
    dealId, (dealInfo.target_is_filer ? targetResult?.id : acquirerResult?.id) || null, filingType,
    trunc(detail?.document_url || filing.filing_url, 500),
    trunc(filing.filing_url, 500),
    trunc(filing.id.split(':')[0], 30),  // clean accession only, no colon+filename
    filing.cik,
    filing.filing_date,
  ]);

  return 'new';
}

async function fetchFilingDetail(cik, accessionNo) {
  try {
    if (!cik || !accessionNo) return null;
    const cleanAccession = String(accessionNo).replace(/-/g, '');
    const url  = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10,'0')}.json`;
    const data = await fetchJson(url);
    if (!data) return null;
    const filings = data.filings?.recent;
    if (!filings) return { company_name: data.name, sic: data.sic };
    const idx = filings.accessionNumber?.findIndex(a => a.replace(/-/g,'') === cleanAccession);
    if (idx === undefined || idx < 0) return { company_name: data.name, sic: data.sic };
    return {
      company_name: data.name,
      sic:          data.sic,
      document_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanAccession}/${filings.primaryDocument?.[idx] || ''}`,
    };
  } catch { return null; }
}

async function fetchFilingText(documentUrl) {
  if (!documentUrl) return '';
  try {
    return await new Promise((resolve) => {
      const req = https.get(documentUrl, {
        headers: { 'User-Agent': 'mergers.news contact@mergers.news', 'Accept': 'text/html,text/plain' }
      }, res => {
        let data = '';
        res.on('data', c => { data += c; if (data.length > 40000) { req.destroy(); resolve(data.slice(0, 40000)); } });
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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractOtherParty(text, filingType) {
  if (!text || text.length < 100) return null;
  if (filingType === 'DEFM14A' || filingType === 'PREM14A' || filingType === 'DEFA14A') {
    const patterns = [
      /to\s+be\s+acquired\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /acquisition\s+by\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /PROPOSED\s+MERGER\s+WITH\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m?.[1]) { const n = m[1].trim().replace(/\s+/g, ' '); if (n.length >= 3 && n.length <= 80 && !/^(the|a|an|this)\b/i.test(n)) return n; }
    }
  }
  if (filingType === 'SC TO-T' || filingType === 'SC TO-T/A') {
    const patterns = [
      /Offer\s+to\s+Purchase\s+(?:All\s+)?(?:Outstanding\s+)?(?:Shares|Stock)\s+of\s+(?:Common\s+Stock\s+of\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
      /(?:acquire|purchase)\s+(?:all\s+)?(?:outstanding\s+)?(?:shares|stock)\s+of\s+([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m?.[1]) { const n = m[1].trim().replace(/\s+/g, ' '); if (n.length >= 3 && n.length <= 80 && !/^(the|a|an|all|any)\b/i.test(n)) return n; }
    }
  }
  if (filingType === 'S-4') {
    const m = text.match(/merger\s+with\s+(?:and\s+into\s+)?([A-Z][A-Za-z0-9\s,\.&'-]{2,60}(?:Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Co\.?|Plc\.?)?)/i);
    if (m?.[1]) { const n = m[1].trim(); if (n.length >= 3 && n.length <= 80) return n; }
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

function extractDealInfo(filing, detail, filingType, docText) {
  const companyName = detail?.company_name || filing.entity_name || 'Unknown';
  const otherParty  = extractOtherParty(docText, filingType);
  const generic = extractParties(docText);
  const dealValueCents = extractDealValueCents(docText);
  let acquirer, target, dealType;
  switch (filingType) {
    case 'DEFM14A': case 'PREM14A': case 'DEFA14A':
      target = companyName; acquirer = firstReliable(otherParty, generic.acquirer); dealType = 'Merger'; break;
    case 'SC TO-T': case 'SC TO-T/A':
      acquirer = companyName; target = firstReliable(otherParty, generic.target); dealType = 'Acquisition'; break;
    case 'S-4':
      acquirer = companyName; target = firstReliable(otherParty, generic.target); dealType = 'Merger'; break;
    case 'SC 13E-3': case 'SC 13E-3/A':
      acquirer = companyName; target = companyName; dealType = 'Going-Private'; break;
    default:
      acquirer = companyName; target = firstReliable(otherParty, generic.target); dealType = 'Merger';
  }
  return {
    headline:          `${acquirer || 'Unknown acquirer'} / ${target || 'Unknown target'}`,
    acquirer:          acquirer ? { name: acquirer, cik: filing.cik } : null,
    target:            target ? { name: target } : null,
    extracted_acquirer_name: acquirer,
    extracted_target_name: target,
    raw_extracted_snippet: rawSnippet(docText),
    acquirer_is_filer: !['DEFM14A', 'PREM14A', 'DEFA14A'].includes(filingType),
    target_is_filer: ['DEFM14A', 'PREM14A', 'DEFA14A'].includes(filingType),
    deal_type:         dealType,
    deal_value_cents:  dealValueCents,
    status:            'Announced',
    filing_type:       filingType,
    filing_date:       filing.filing_date,
    announcement_date: filing.filing_date,
    source_url:        filing.filing_url,
    sector:            sicToSector(detail?.sic),
    source_confidence: otherParty ? 0.8 : 0.7,
    needs_review:      !isReliableName(acquirer) || !isReliableName(target),
  };
}

async function upsertCompany(info, cik) {
  if (!info || !isReliableName(info.name)) return null;
  const normalized = normalizeName(info.name);
  if (cik) {
    const byCik = await db.query('SELECT id FROM companies WHERE cik=$1', [cik]);
    if (byCik.rows.length) return byCik.rows[0];
  }
  const byName = await db.query('SELECT id FROM companies WHERE normalized_name=$1 LIMIT 1', [normalized]);
  if (byName.rows.length) return byName.rows[0];
  const res = await db.query(
    'INSERT INTO companies (name,normalized_name,cik) VALUES ($1,$2,$3) RETURNING id',
    [trunc(info.name,500), trunc(normalized,500), cik || null]
  );
  return res.rows[0];
}

async function insertDeal(info) {
  const res = await db.query(`
    INSERT INTO deals (acquirer_id,target_id,headline,deal_type,status,announcement_date,
      filing_date,sector,deal_value,source_confidence,extraction_method,needs_review,
      extracted_acquirer_name,extracted_target_name,raw_extracted_snippet)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sec_filing',$11,$12,$13,$14)
    RETURNING id
  `, [
    info.acquirer_id, info.target_id, info.headline, info.deal_type, info.status,
    info.announcement_date||null, info.filing_date||null, info.sector||null,
    info.deal_value_cents||null, info.source_confidence||0.7, Boolean(info.needs_review),
    trunc(info.extracted_acquirer_name,500), trunc(info.extracted_target_name,500), info.raw_extracted_snippet,
  ]);
  const dealId = res.rows[0].id;
  await db.query(
    `INSERT INTO deal_sources (deal_id,source_type,source_name,source_url,source_date)
     VALUES ($1,'sec_edgar','SEC EDGAR',$2,$3)`,
    [dealId, trunc(info.source_url,500), info.filing_date||null]
  );
  return dealId;
}

function trunc(str, len) { return str ? String(str).slice(0, len) : str; }
function normalizeName(name) {
  return String(name).toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,'')
    .replace(/\s+/g,' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited)\b/g,'')
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
function extractCIK(id) {
  if (!id) return '';
  const m = String(id).match(/^(\d{10})-\d{2}-\d{6}/);
  if (m) return parseInt(m[1], 10).toString();
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'mergers.news contact@mergers.news', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

run().catch(err => { console.error('[BACKFILL] Fatal:', err); db.end(); });
