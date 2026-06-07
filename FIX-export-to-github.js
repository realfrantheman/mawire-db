/**
 * mergers.news — GitHub Export Script
 * Exports deals from PostgreSQL → deals.json → GitHub
 */

'use strict';

const https    = require('https');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO || 'realfrantheman/mawire-db';
const GITHUB_FILE  = process.env.GITHUB_FILE || 'deals.json';

async function run() {
  console.log('[EXPORT] Fetching deals from PostgreSQL...');

  const res = await db.query(`
    SELECT
      d.id,
      d.headline,
      a.name  AS acquirer,
      t.name  AS target,
      d.deal_type  AS "dealType",
      d.status,
      d.deal_value / 100.0 AS "dealValueRaw",
      CASE
        WHEN d.deal_value >= 1000000000000 THEN '$' || ROUND(d.deal_value/100.0/1e12,1)::text || 'T'
        WHEN d.deal_value >= 1000000000    THEN '$' || ROUND(d.deal_value/100.0/1e9,1)::text  || 'B'
        WHEN d.deal_value >= 1000000       THEN '$' || ROUND(d.deal_value/100.0/1e6,1)::text  || 'M'
        WHEN d.deal_value IS NULL          THEN 'Undisclosed'
        ELSE '$' || (d.deal_value/100)::text
      END AS "dealValue",
      d.per_share_value AS "perShare",
      d.premium_pct AS premium,
      d.sector,
      d.region,
      d.country,
      d.announcement_date AS date,
      EXTRACT(YEAR FROM d.announcement_date)::int AS year,
      d.announcement_date::text AS "dateISO",
      d.close_date AS "closingDate",
      d.is_private_equity AS "isPrivateEquity",
      d.is_hostile AS "isHostile",
      d.ai_summary AS body,
      d.source_confidence AS confidence,
      ds.source_url AS "sourceUrl",
      f.filing_type AS "filingType",
      f.edgar_url AS "edgarUrl",
      f.accession_no AS "accessionNo"
    FROM deals d
    LEFT JOIN companies a     ON d.acquirer_id = a.id
    LEFT JOIN companies t     ON d.target_id   = t.id
    LEFT JOIN deal_sources ds ON ds.deal_id    = d.id AND ds.source_type = 'sec_edgar'
    LEFT JOIN filings f       ON f.deal_id     = d.id
    WHERE d.canonical_id IS NULL
    ORDER BY d.announcement_date DESC NULLS LAST
  `);

  const deals = res.rows.map(row => ({
    id:          row.id,
    headline:    row.headline || `${row.acquirer || '?'} / ${row.target || '?'}`,
    acquirer:    row.acquirer || 'Undisclosed',
    target:      row.target   || 'Undisclosed',
    dealType:    row.dealType,
    status:      row.status,
    dealValue:   row.dealValue,
    perShare:    row.perShare  ? `$${row.perShare}` : null,
    premium:     row.premium   ? `${Math.round(row.premium * 100)}%` : null,
    sector:      row.sector,
    region:      row.region,
    country:     row.country,
    date:        row.date ? new Date(row.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
    year:        row.year,
    dateISO:     row.dateISO,
    closingDate: row.closingDate,
    body:        row.body,
    sourceUrl:   row.sourceUrl || row.edgarUrl,
    filingType:  row.filingType,
    edgarUrl:    row.edgarUrl,
    confidence:  row.confidence,
    breaking:    row.year === new Date().getFullYear() && row.status === 'Announced',
  }));

  console.log(`[EXPORT] Exporting ${deals.length} deals to GitHub...`);

  const json    = JSON.stringify(deals, null, 2);
  const encoded = Buffer.from(json).toString('base64');
  const sha     = await getFileSHA();

  console.log('[EXPORT] Current SHA:', sha || 'new file');

  await pushToGitHub(encoded, sha);
  console.log('[EXPORT] Done! GitHub updated with', deals.length, 'deals');
  // do not call db.end() — pool is reused across scheduled runs
}

async function getFileSHA() {
  return new Promise(resolve => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      headers:  {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent':    'mergers-news-platform',
        'Accept':        'application/vnd.github.v3+json',
      },
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).sha || null); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function pushToGitHub(content, sha) {
  const body = JSON.stringify({
    message: `Update deals.json — ${new Date().toISOString().slice(0, 10)}`,
    content,
    sha:    sha || undefined,
    branch: 'main',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      method:   'PUT',
      headers:  {
        'Authorization':  `token ${GITHUB_TOKEN}`,
        'User-Agent':     'mergers-news-platform',
        'Accept':         'application/vnd.github.v3+json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { run };

if (require.main === module) {
  run().then(() => db.end()).catch(err => {
    console.error('[EXPORT] Fatal:', err.message);
    db.end();
    process.exit(1);
  });
}
