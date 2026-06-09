/**
 * mergers.news — Historical M&A Backfill
 * Fetches ALL SEC EDGAR M&A filings from 1993 to today
 * Run once: node scripts/historical-backfill.js
 * Then let the scheduler handle ongoing ingestion
 */

'use strict';

const https    = require('https');
const http     = require('http');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const FILING_TYPES  = ['DEFM14A', 'SC TO-T', 'S-4', 'SC 13E-3', 'DEFA14A', 'SC TO-T/A', 'PREM14A', 'SC 13E-3/A'];
const START_YEAR    = 1993;
const END_YEAR      = new Date().getFullYear();
const DELAY_MS      = 600; // be polite to SEC servers

async function run() {
  console.log(`[BACKFILL] Starting historical backfill ${START_YEAR}–${END_YEAR}`);
  console.log(`[BACKFILL] Filing types: ${FILING_TYPES.join(', ')}`);

  let totalNew = 0, totalSkipped = 0, totalFailed = 0;

  for (const filingType of FILING_TYPES) {
    console.log(`\n[BACKFILL] === ${filingType} ===`);

    for (let year = END_YEAR; year >= START_YEAR; year--) {
      const startdt = `${year}-01-01`;
      const enddt   = `${year}-12-31`;

      try {
        const filings = await fetchFilingsForPeriod(filingType, startdt, enddt);
        console.log(`[BACKFILL] ${filingType} ${year}: ${filings.length} filings`);

        for (const filing of filings) {
          try {
            const result = await processFiling(filing, filingType);
            if (result === 'new')     totalNew++;
            if (result === 'skip')    totalSkipped++;
          } catch (err) {
            totalFailed++;
            // silent — keep going
          }
          await sleep(DELAY_MS);
        }
      } catch (err) {
        console.error(`[BACKFILL] ${filingType} ${year} error:`, err.message);
      }

      await sleep(500);
    }
  }

  console.log(`\n[BACKFILL] Complete: ${totalNew} new, ${totalSkipped} skipped, ${totalFailed} failed`);
  await db.end();
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
      allFilings.push({
        id:          hit._id,
        entity_name: hit._source?.entity_name || hit._source?.display_names?.[0] || 'Unknown',
        cik:         hit._source?.entity_id   || extractCIK(hit._id),
        filing_date: hit._source?.file_date   || hit._source?.period_of_report,
        filing_url:  `https://www.sec.gov/Archives/edgar/data/${hit._source?.entity_id || extractCIK(hit._id)}/${String(hit._id).replace(/-/g,'').replace(/\//g,'')}/`,
      });
    });

    const total = data.hits.total?.value || 0;
    from += size;
    if (from >= total || from >= 10000) break; // EDGAR caps at 10k per query
    await sleep(400);
  }

  return allFilings;
}

async function processFiling(filing, filingType) {
  const existing = await db.query('SELECT id FROM filings WHERE accession_no = $1', [filing.id]);
  if (existing.rows.length > 0) return 'skip';

  const detail  = await fetchFilingDetail(filing.cik, filing.id);
  const dealInfo = extractDealInfo(filing, detail, filingType);

  const acquirerResult = await upsertCompany(dealInfo.acquirer, filing.cik);
  const targetResult   = await upsertCompany(dealInfo.target, null);

  const dealId = await insertDeal({
    ...dealInfo,
    acquirer_id: acquirerResult.id,
    target_id:   targetResult?.id,
  });

  await db.query(`
    INSERT INTO filings (deal_id, company_id, filing_type, document_url, edgar_url, accession_no, cik, filing_date, processed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
  `, [
    dealId, acquirerResult.id, filingType,
    trunc(detail?.document_url || filing.filing_url, 500),
    trunc(filing.filing_url, 500),
    trunc(filing.id, 50),
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

function extractDealInfo(filing, detail, filingType) {
  const companyName = detail?.company_name || filing.entity_name || 'Unknown';
  let acquirer, target, dealType;
  switch (filingType) {
    case 'DEFM14A': case 'PREM14A':
      target = companyName; acquirer = 'Acquirer (see filing)'; dealType = 'Merger'; break;
    case 'SC TO-T': case 'SC TO-T/A':
      acquirer = companyName; target = 'Target (see filing)'; dealType = 'Acquisition'; break;
    case 'S-4':
      acquirer = companyName; target = 'Target (see filing)'; dealType = 'Merger'; break;
    case 'SC 13E-3': case 'SC 13E-3/A':
      acquirer = companyName; target = companyName; dealType = 'Going-Private'; break;
    default:
      acquirer = companyName; target = 'Unknown'; dealType = 'Merger';
  }
  return {
    headline:          `${acquirer} / ${target}`,
    acquirer:          { name: acquirer, cik: filing.cik },
    target:            { name: target },
    deal_type:         dealType,
    status:            'Announced',
    filing_type:       filingType,
    filing_date:       filing.filing_date,
    announcement_date: filing.filing_date,
    source_url:        filing.filing_url,
    sector:            sicToSector(detail?.sic),
    source_confidence: 0.7,
    needs_review:      true,
  };
}

async function upsertCompany(info, cik) {
  if (!info || !info.name || info.name === 'Unknown') {
    const res = await db.query(
      `INSERT INTO companies (name, normalized_name, cik)
       VALUES ('Unknown','unknown',$1)
       ON CONFLICT (cik) WHERE cik IS NOT NULL DO UPDATE SET updated_at=NOW()
       RETURNING id`, [cik || null]
    );
    return res.rows[0];
  }
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
      filing_date,sector,source_confidence,extraction_method,needs_review)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sec_filing',$10)
    RETURNING id
  `, [
    info.acquirer_id, info.target_id, info.headline, info.deal_type, info.status,
    info.announcement_date||null, info.filing_date||null, info.sector||null,
    info.source_confidence||0.7, info.needs_review||true,
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
  return String(id).split(':')[0] || '';
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
