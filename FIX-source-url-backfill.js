'use strict';

const { Pool } = require('pg');
const { secSubmissionUrl } = require('./FIX-source-url');
const DB_URL = process.env.DATABASE_URL;
const LIMIT = Math.max(1, parseInt(process.env.SOURCE_BACKFILL_LIMIT || '200', 10));
const db = new Pool({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
});
const UA = 'mergers.news contact@mergers.news';

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function arraysToFilings(data) {
  const f = data && data.filings ? (data.filings.recent || data.filings) : data;
  if (!f || !Array.isArray(f.accessionNumber)) return [];
  return f.accessionNumber.map(function (accession, i) {
    return { accession, form: f.form && f.form[i], filingDate: f.filingDate && f.filingDate[i], primaryDocument: f.primaryDocument && f.primaryDocument[i] };
  });
}

async function submissionsForDate(cik, date) {
  const padded = String(cik).replace(/\D/g, '').padStart(10, '0');
  const main = await fetchJson(`https://data.sec.gov/submissions/CIK${padded}.json`);
  var rows = arraysToFilings(main);
  const files = main.filings && Array.isArray(main.filings.files) ? main.filings.files : [];
  const needed = files.find(function (f) { return f.filingFrom && f.filingTo && date >= f.filingFrom && date <= f.filingTo; });
  if (needed && needed.name) {
    try { rows = rows.concat(arraysToFilings(await fetchJson(`https://data.sec.gov/submissions/${needed.name}`))); } catch (_) {}
  }
  return rows;
}

function preferredForms(dealType) {
  const t = String(dealType || '').toLowerCase();
  if (t.includes('tender')) return new Set(['SC TO-T','SC TO-T/A']);
  if (t.includes('going-private') || t.includes('going private')) return new Set(['SC 13E-3','SC 13E-3/A']);
  return new Set(['DEFM14A','PREM14A','DEFA14A','S-4','S-4/A']);
}

async function resolveCandidate(row) {
  const date = String(row.filing_date || row.announcement_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ciks = [row.target_cik, row.acquirer_cik].filter(Boolean);
  const forms = preferredForms(row.deal_type);
  for (const cik of ciks) {
    let filings;
    try { filings = await submissionsForDate(cik, date); } catch (_) { continue; }
    const exact = filings.filter(function (f) { return f.filingDate === date && forms.has(f.form) && /^\d{10}-\d{2}-\d{6}$/.test(f.accession || ''); });
    if (exact.length !== 1) continue;
    const f = exact[0];
    const folder = f.accession.replace(/-/g, '');
    const cleanCik = String(parseInt(String(cik).replace(/\D/g, ''), 10));
    const documentUrl = f.primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${cleanCik}/${folder}/${f.primaryDocument}` : secSubmissionUrl(f.accession);
    return { cik: cleanCik, form: f.form, accession: f.accession, date: f.filingDate, documentUrl };
  }
  return null;
}

async function run() {
  const candidates = await db.query(`
    SELECT d.id, d.deal_type, d.filing_date, d.announcement_date,
           a.cik AS acquirer_cik, t.cik AS target_cik
    FROM deals d
    LEFT JOIN companies a ON a.id = d.acquirer_id
    LEFT JOIN companies t ON t.id = d.target_id
    LEFT JOIN LATERAL (SELECT * FROM filings f WHERE f.deal_id=d.id ORDER BY f.created_at LIMIT 1) f ON true
    LEFT JOIN LATERAL (SELECT * FROM deal_sources ds WHERE ds.deal_id=d.id ORDER BY ds.created_at LIMIT 1) ds ON true
    WHERE d.extraction_method = 'sec_filing'
      AND (COALESCE(f.document_url,'') = '' OR f.document_url ~ '-index\\.html$' OR f.document_url ~ '/data/[0-9]{12,}/')
      AND COALESCE(ds.source_url,'') = ''
    ORDER BY COALESCE(d.filing_date,d.announcement_date) DESC NULLS LAST
    LIMIT $1
  `, [LIMIT]);
  let fixed = 0, unresolved = 0;
  for (const row of candidates.rows) {
    const hit = await resolveCandidate(row);
    if (!hit) { unresolved++; continue; }
    await db.query('BEGIN');
    try {
      const existing = await db.query('SELECT id FROM filings WHERE deal_id=$1 ORDER BY created_at LIMIT 1', [row.id]);
      if (existing.rows.length) {
        await db.query(`UPDATE filings SET filing_type=$1, document_url=$2, edgar_url=$2, accession_no=$3, cik=$4, filing_date=$5, processed=true WHERE id=$6`, [hit.form, hit.documentUrl, hit.accession, hit.cik, hit.date, existing.rows[0].id]);
      } else {
        await db.query(`INSERT INTO filings (deal_id,filing_type,document_url,edgar_url,accession_no,cik,filing_date,processed) VALUES ($1,$2,$3,$3,$4,$5,$6,true)`, [row.id, hit.form, hit.documentUrl, hit.accession, hit.cik, hit.date]);
      }
      const source = await db.query('SELECT id FROM deal_sources WHERE deal_id=$1 ORDER BY created_at LIMIT 1', [row.id]);
      if (source.rows.length) await db.query(`UPDATE deal_sources SET source_type='sec_edgar', source_name='SEC EDGAR', source_url=$1, source_date=$2 WHERE id=$3`, [hit.documentUrl, hit.date, source.rows[0].id]);
      else await db.query(`INSERT INTO deal_sources (deal_id,source_type,source_name,source_url,source_date,confidence) VALUES ($1,'sec_edgar','SEC EDGAR',$2,$3,1.0)`, [row.id, hit.documentUrl, hit.date]);
      await db.query('COMMIT'); fixed++;
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  console.log(`[SOURCE-BACKFILL] fixed=${fixed} unresolved=${unresolved} scanned=${candidates.rows.length}`);
  await db.end();
}

if (require.main === module) run().catch(function (e) { console.error(e); process.exit(1); });
module.exports = { run, preferredForms };
