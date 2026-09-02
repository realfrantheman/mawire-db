'use strict';

const { Pool } = require('pg');
const { secSubmissionUrl } = require('./FIX-source-url');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const LIMIT = Math.max(1, Math.min(5000, Number.parseInt(process.env.SOURCE_BACKFILL_LIMIT || '200', 10)));
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 5,
  statement_timeout: 120000,
});
const UA = 'mergers.news contact@mergers.news';

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function arraysToFilings(data) {
  const filings = data?.filings ? (data.filings.recent || data.filings) : data;
  if (!filings || !Array.isArray(filings.accessionNumber)) return [];
  return filings.accessionNumber.map((accession, index) => ({
    accession,
    form: filings.form?.[index],
    filingDate: filings.filingDate?.[index],
    primaryDocument: filings.primaryDocument?.[index],
  }));
}

async function submissionsForDate(cik, date) {
  const padded = String(cik).replace(/\D/g, '').padStart(10, '0');
  const main = await fetchJson(`https://data.sec.gov/submissions/CIK${padded}.json`);
  let rows = arraysToFilings(main);
  const files = Array.isArray(main?.filings?.files) ? main.filings.files : [];
  const needed = files.find(file => file.filingFrom && file.filingTo && date >= file.filingFrom && date <= file.filingTo);
  if (needed?.name) {
    try {
      rows = rows.concat(arraysToFilings(await fetchJson(`https://data.sec.gov/submissions/${needed.name}`)));
    } catch (error) {
      console.warn(`[SOURCE-BACKFILL] historical submissions ${needed.name} unavailable: ${error.message}`);
    }
  }
  return rows;
}

function preferredForms(dealType) {
  const type = String(dealType || '').toLowerCase();
  if (type.includes('tender')) return new Set(['SC TO-T', 'SC TO-T/A']);
  if (type.includes('going-private') || type.includes('going private') || type.includes('lbo')) return new Set(['SC 13E-3', 'SC 13E-3/A']);
  return new Set(['DEFM14A', 'PREM14A', 'DEFA14A', 'S-4', 'S-4/A']);
}

function directSecDocumentUrl(cik, accession, primaryDocument) {
  if (!cik || !accession || !primaryDocument) return null;
  const cleanCik = String(Number.parseInt(String(cik).replace(/\D/g, ''), 10));
  const folder = String(accession).replace(/-/g, '');
  if (!cleanCik || cleanCik === 'NaN' || !folder) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cleanCik}/${folder}/${primaryDocument}`;
}

function isSpecificSourceUrl(value) {
  if (!value) return false;
  let parsed;
  try { parsed = new URL(String(value)); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('sec.gov')) return true;
  if (/\/cgi-bin\/browse-edgar/i.test(parsed.pathname)) return false;
  if (/\/LATEST\/search-index/i.test(parsed.pathname)) return false;
  if (/-index\.html?$/i.test(parsed.pathname)) return false;
  if (/\/Archives\/edgar\/data\/\d+\/\d+\/?$/i.test(parsed.pathname)) return false;
  return /\/Archives\/edgar\/data\/\d+\/\d+\/.+\.(?:html?|txt)$/i.test(parsed.pathname);
}

async function resolveCandidate(row) {
  const date = String(row.filing_date || row.announcement_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ciks = [...new Set([row.target_cik, row.acquirer_cik].filter(Boolean).map(String))];
  const forms = preferredForms(row.deal_type);

  for (const cik of ciks) {
    let filings;
    try {
      filings = await submissionsForDate(cik, date);
    } catch (error) {
      console.warn(`[SOURCE-BACKFILL] CIK ${cik} submissions unavailable: ${error.message}`);
      continue;
    }
    const matches = filings.filter(filing =>
      filing.filingDate === date &&
      forms.has(filing.form) &&
      /^\d{10}-\d{2}-\d{6}$/.test(filing.accession || '') &&
      filing.primaryDocument
    );
    if (matches.length !== 1) continue;
    const filing = matches[0];
    const documentUrl = directSecDocumentUrl(cik, filing.accession, filing.primaryDocument) || secSubmissionUrl(filing.accession);
    if (!isSpecificSourceUrl(documentUrl)) continue;
    return {
      cik: String(Number.parseInt(String(cik).replace(/\D/g, ''), 10)),
      form: filing.form,
      accession: filing.accession,
      date: filing.filingDate,
      documentUrl,
    };
  }
  return null;
}

async function selectCandidates() {
  return db.query(`
    SELECT d.id,d.deal_type,d.filing_date,d.announcement_date,d.needs_review,d.source_confidence,
           a.cik AS acquirer_cik,t.cik AS target_cik,
           f.id AS filing_id,f.document_url,
           ds.id AS source_id,ds.source_url
    FROM deals d
    LEFT JOIN companies a ON a.id=d.acquirer_id
    LEFT JOIN companies t ON t.id=d.target_id
    LEFT JOIN LATERAL (
      SELECT id,document_url
      FROM filings f
      WHERE f.deal_id=d.id
      ORDER BY filing_date DESC NULLS LAST,created_at DESC,id
      LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT id,source_url
      FROM deal_sources ds
      WHERE ds.deal_id=d.id
      ORDER BY confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id
      LIMIT 1
    ) ds ON true
    WHERE d.canonical_id IS NULL
      AND d.extraction_method='sec_filing'
      AND (
        COALESCE(f.document_url,'')='' OR
        f.document_url ~* 'browse-edgar|search-index|-index\\.html?$|/Archives/edgar/data/[0-9]+/[0-9]+/?$' OR
        COALESCE(ds.source_url,'')='' OR
        ds.source_url ~* 'browse-edgar|search-index|-index\\.html?$|/Archives/edgar/data/[0-9]+/[0-9]+/?$'
      )
    ORDER BY d.needs_review DESC,
             d.source_confidence DESC NULLS LAST,
             COALESCE(d.filing_date,d.announcement_date) DESC NULLS LAST,
             d.id
    LIMIT $1
  `, [LIMIT]);
}

async function persistResolved(row, hit) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mawire:source-backfill:${row.id}`]);

    const collision = await client.query('SELECT id,deal_id FROM deal_sources WHERE source_url=$1 AND deal_id<>$2 LIMIT 1', [hit.documentUrl, row.id]);
    if (collision.rows.length) {
      await client.query('ROLLBACK');
      return { status: 'collision', otherDealId: collision.rows[0].deal_id };
    }

    const filing = await client.query('SELECT id FROM filings WHERE deal_id=$1 ORDER BY filing_date DESC NULLS LAST,created_at DESC,id LIMIT 1', [row.id]);
    if (filing.rows.length) {
      await client.query(`UPDATE filings SET filing_type=$1,document_url=$2,edgar_url=$2,accession_no=$3,cik=$4,filing_date=$5,processed=true WHERE id=$6`, [hit.form, hit.documentUrl, hit.accession, hit.cik, hit.date, filing.rows[0].id]);
    } else {
      await client.query(`INSERT INTO filings(deal_id,filing_type,document_url,edgar_url,accession_no,cik,filing_date,processed) VALUES($1,$2,$3,$3,$4,$5,$6,true)`, [row.id, hit.form, hit.documentUrl, hit.accession, hit.cik, hit.date]);
    }

    const source = await client.query('SELECT id FROM deal_sources WHERE deal_id=$1 ORDER BY confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id LIMIT 1', [row.id]);
    if (source.rows.length) {
      await client.query(`UPDATE deal_sources SET source_type='sec_edgar',source_name='SEC EDGAR',source_url=$1,source_date=$2,confidence=GREATEST(COALESCE(confidence,0),1.0) WHERE id=$3`, [hit.documentUrl, hit.date, source.rows[0].id]);
    } else {
      await client.query(`INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,confidence) VALUES($1,'sec_edgar','SEC EDGAR',$2,$3,1.0)`, [row.id, hit.documentUrl, hit.date]);
    }

    await client.query('COMMIT');
    return { status: 'fixed' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  const candidates = await selectCandidates();
  const stats = { fixed: 0, unresolved: 0, collisions: 0, scanned: candidates.rows.length };

  for (const row of candidates.rows) {
    const hit = await resolveCandidate(row);
    if (!hit) {
      stats.unresolved++;
      continue;
    }
    const result = await persistResolved(row, hit);
    if (result.status === 'fixed') stats.fixed++;
    else {
      stats.collisions++;
      console.warn(`[SOURCE-BACKFILL] source collision for deal ${row.id} with ${result.otherDealId}`);
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  console.log(`[SOURCE-BACKFILL] fixed=${stats.fixed} unresolved=${stats.unresolved} collisions=${stats.collisions} scanned=${stats.scanned}`);
  return stats;
}

async function close() {
  await db.end();
}

if (require.main === module) {
  run()
    .then(() => close())
    .catch(async error => {
      console.error(error.stack || error);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}

module.exports = { run, close, preferredForms, isSpecificSourceUrl, resolveCandidate, persistResolved };
