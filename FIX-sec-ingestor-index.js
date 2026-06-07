/**
 * mergers.news — SEC EDGAR Ingestion Service
 * Runs every 30 minutes via cron
 * Fetches DEFM14A, SC TO-T, S-4, SC 13E-3 filings
 * Stores raw filing to S3, deal record to PostgreSQL
 */

'use strict';

const https    = require('https');
const http     = require('http');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ── CONFIG ────────────────────────────────────────────────────────
const CONFIG = {
  edgar_base:    'https://efts.sec.gov/LATEST/search-index',
  edgar_full:    'https://efts.sec.gov/LATEST/search-index',
  edgar_filing:  'https://www.sec.gov/cgi-bin/browse-edgar',
  edgar_archive: 'https://www.sec.gov/Archives/edgar/data',
  s3_bucket:     process.env.S3_BUCKET    || 'mergers-news-raw',
  s3_prefix:     'sec/',
  db_url:        process.env.DATABASE_URL,
  batch_size:    100,
  // Filing types to ingest
  filing_types: ['DEFM14A', 'SC TO-T', 'S-4', 'SC 13E-3', 'DEFA14A', 'SC TO-T/A'],
  // How far back to look on each run (days)
  lookback_days: 2,
};

const db = new Pool({ connectionString: CONFIG.db_url, ssl: { rejectUnauthorized: false } });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

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

  const data = await fetchJson(`https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(filingType)}&dateRange=custom&startdt=${dateStr}`);

  if (!data || !data.hits || !data.hits.hits) return [];

  return data.hits.hits.map(hit => ({
    id:           hit._id,
    accession_no: hit._source?.period_of_report,
    entity_name:  hit._source?.entity_name || hit._source?.display_names?.[0] || 'Unknown',
    cik:          hit._source?.entity_id   || extractCIK(hit._id),
    filing_date:  hit._source?.period_of_report || hit._source?.file_date,
    filing_url:   `https://www.sec.gov/Archives/edgar/data/${extractCIK(hit._id)}/${hit._id.replace(/-/g,'').replace(/\//g,'')}/`,
    document_url: hit._source?.file_date,
    raw:          hit._source,
  }));
}

function extractCIK(id) {
  if (!id) return '';
  const parts = String(id).split(':');
  return parts[0] || '';
}

// ── PROCESS A SINGLE FILING ────────────────────────────────────────
async function processFiling(filing, filingType) {
  // Check if already processed
  const existing = await db.query(
    'SELECT id FROM filings WHERE accession_no = $1',
    [filing.id]
  );
  if (existing.rows.length > 0) return 'skip';

  // Fetch filing detail from EDGAR
  const detail = await fetchFilingDetail(filing.cik, filing.id);

  // Store raw to S3
  const s3Key = `${CONFIG.s3_prefix}${filingType}/${filing.cik}/${filing.id}.json`;
  await storeS3(s3Key, { filing, detail, fetched_at: new Date().toISOString() });

  // Extract deal info
  const dealInfo = extractDealInfo(filing, detail, filingType);

  // Upsert company records
  const acquirerResult = await upsertCompany(dealInfo.acquirer, filing.cik);
  const targetResult   = await upsertCompany(dealInfo.target, null);

  // Insert deal record
  const dealId = await insertDeal({
    ...dealInfo,
    acquirer_id:       acquirerResult.id,
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
    acquirerResult.id,
    filingType,
    detail?.document_url || filing.filing_url,
    filing.filing_url,
    filing.id,
    filing.cik,
    filing.filing_date,
  ]);

  return 'new';
}

// ── FETCH FILING DETAIL ───────────────────────────────────────────
async function fetchFilingDetail(cik, accessionNo) {
  try {
    if (!cik || !accessionNo) return null;
    const cleanAccession = String(accessionNo).replace(/-/g, '');
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

// ── EXTRACT DEAL INFO FROM FILING ─────────────────────────────────
function extractDealInfo(filing, detail, filingType) {
  const companyName = detail?.company_name || filing.entity_name || 'Unknown';

  let acquirer, target, dealType, status;

  switch (filingType) {
    case 'DEFM14A':
      target   = companyName;
      acquirer = 'Acquirer (see filing)';
      dealType = 'Merger';
      status   = 'Announced';
      break;
    case 'SC TO-T':
    case 'SC TO-T/A':
      acquirer = companyName;
      target   = 'Target (see filing)';
      dealType = 'Acquisition';
      status   = 'Announced';
      break;
    case 'S-4':
      acquirer = companyName;
      target   = 'Target (see filing)';
      dealType = 'Merger';
      status   = 'Announced';
      break;
    case 'SC 13E-3':
      acquirer = companyName;
      target   = companyName;
      dealType = 'Going-Private';
      status   = 'Announced';
      break;
    default:
      acquirer = companyName;
      target   = 'Unknown';
      dealType = 'Merger';
      status   = 'Announced';
  }

  return {
    headline:       `${acquirer} / ${target}`,
    acquirer:       { name: acquirer, cik: filing.cik },
    target:         { name: target },
    deal_type:      dealType,
    status,
    filing_type:    filingType,
    filing_date:    filing.filing_date,
    announcement_date: filing.filing_date,
    source_url:     filing.filing_url,
    sector:         sicToSector(detail?.sic),
    source_confidence: 0.7,
    needs_review:   true,
  };
}

// ── COMPANY UPSERT ─────────────────────────────────────────────────
async function upsertCompany(info, cik) {
  if (!info || !info.name || info.name === 'Unknown') {
    const res = await db.query(
      `INSERT INTO companies (name, normalized_name, cik)
       VALUES ('Unknown', 'unknown', $1)
       ON CONFLICT (cik) WHERE cik IS NOT NULL DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [cik || null]
    );
    return res.rows[0];
  }

  const normalized = normalizeName(info.name);

  if (cik) {
    const byCik = await db.query('SELECT id FROM companies WHERE cik = $1', [cik]);
    if (byCik.rows.length) return byCik.rows[0];
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
    [info.name, normalized, cik || null]
  );
  return res.rows[0];
}

// ── INSERT DEAL ────────────────────────────────────────────────────
async function insertDeal(info) {
  const res = await db.query(`
    INSERT INTO deals (
      acquirer_id, target_id, headline, deal_type, status,
      announcement_date, filing_date, sector, source_confidence,
      extraction_method, needs_review
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
    info.source_confidence || 0.7,
    info.extraction_method || 'sec_filing',
    info.needs_review || true,
  ]);

  const dealId = res.rows[0].id;

  await db.query(`
    INSERT INTO deal_sources (deal_id, source_type, source_name, source_url, source_date)
    VALUES ($1, 'sec_edgar', 'SEC EDGAR', $2, $3)
  `, [dealId, info.source_url, info.filing_date || null]);

  return dealId;
}

// ── HELPERS ────────────────────────────────────────────────────────
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

async function storeS3(key, data) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: CONFIG.s3_bucket,
      Key:    key,
      Body:   JSON.stringify(data),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.warn('[S3] Could not store:', key, err.message);
  }
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
module.exports = { run };

if (require.main === module) {
  run().catch(console.error);
}
