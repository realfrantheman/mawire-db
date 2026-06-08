'use strict';

const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
});

async function run() {
  const logId = await startLog('eu_merger_registry');
  const stats  = { fetched: 0, new: 0, updated: 0, failed: 0 };

  try {
    console.log('[EU] Starting ingestion run at', new Date().toISOString());

    await runEuMergerRegistry(stats);
    await sleep(2000);
    await runUkCompaniesHouse(stats);

    await endLog(logId, 'success', stats);
    console.log('[EU] Run complete:', stats);
  } catch (err) {
    await endLog(logId, 'failed', stats, err.message);
    console.error('[EU] Fatal error:', err);
  }
}

async function runEuMergerRegistry(stats) {
  console.log('[EU] Fetching EU Merger Registry');

  // EC moved to competition-cases.ec.europa.eu — use their JSON search API
  const url = 'https://competition-cases.ec.europa.eu/search?sortBy=date&sortOrder=desc&pageSize=100&procedureType=M';

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    console.error('[EU] Failed to fetch EU registry:', err.message);
    stats.failed++;
    return;
  }

  // Parse JSON response from new EC portal
  const cases = parseEuJsonCases(data);
  console.log(`[EU] Parsed ${cases.length} EU merger cases`);
  stats.fetched += cases.length;

  for (const c of cases) {
    try {
      const result = await processEuCase(c);
      if (result === 'new') stats.new++;
    } catch (err) {
      stats.failed++;
      console.error(`[EU] Error processing case ${c.caseNumber}:`, err.message);
    }
    await sleep(1000);
  }
}

function parseEuJsonCases(data) {
  if (!data) return [];
  // New EC portal returns { results: [...] } or { hits: [...] }
  const items = data.results || data.hits || data.cases || data.items || (Array.isArray(data) ? data : []);
  const cases = [];
  for (const item of items) {
    const caseNumber = item.caseNumber || item.case_number || item.id || item.reference || '';
    const caseTitle  = item.caseTitle  || item.case_title  || item.title || item.name || '';
    const notifDate  = item.notificationDate || item.notification_date || item.date || item.openingDate || '';
    const statusRaw  = item.status || item.phase || item.outcome || '';
    if (!caseNumber && !caseTitle) continue;
    cases.push({
      caseNumber: String(caseNumber).trim(),
      caseTitle:  String(caseTitle).trim(),
      notifDate:  String(notifDate).trim(),
      status:     normalizeEuStatus(String(statusRaw)),
    });
  }
  return cases;
}

function normalizeEuStatus(raw) {
  const r = raw.toLowerCase();
  if (r.includes('prohibit'))                                        return 'Withdrawn';
  if (r.includes('approv') || r.includes('phase i') || r.includes('cleared')) return 'Completed';
  if (r.includes('phase ii'))                                        return 'Announced';
  return 'Announced';
}

async function processEuCase(c) {
  const caseNum   = c.caseNumber.replace(/[^A-Z0-9._-]/gi, '');
  const caseId    = caseNum.replace('M.', '');
  const sourceUrl = trunc(
    `https://ec.europa.eu/competition/elojade/isef/case_details.cfm?proc_code=2_M_${caseId}`,
    500
  );

  const existing = await db.query(
    'SELECT id FROM deal_sources WHERE source_url = $1 LIMIT 1',
    [sourceUrl]
  );
  if (existing.rows.length > 0) return 'skip';

  const { acquirer, target } = parseEuCaseTitle(c.caseTitle);
  const announcementDate     = parseDateFlexible(c.notifDate);

  const acquirerRec = await upsertCompany(db, { name: acquirer || 'Unknown' }, null);
  const targetRec   = target
    ? await upsertCompany(db, { name: target }, null)
    : null;

  await insertDeal(db, {
    acquirer_id:       acquirerRec.id,
    target_id:         targetRec ? targetRec.id : null,
    headline:          trunc(c.caseTitle || `${acquirer} / ${target}`, 500),
    deal_type:         'Merger',
    status:            c.status,
    announcement_date: announcementDate,
    filing_date:       announcementDate,
    deal_value:        null,
    sector:            null,
    source_confidence: 0.8,
    extraction_method: 'eu_merger_registry',
    needs_review:      true,
    source_type:       'eu_merger_registry',
    source_name:       'EU Competition - Merger Registry',
    source_url:        sourceUrl,
    source_date:       announcementDate,
  });

  return 'new';
}

function parseEuCaseTitle(title) {
  if (!title) return { acquirer: null, target: null };
  const sep = title.indexOf(' / ');
  if (sep !== -1) {
    return {
      acquirer: title.slice(0, sep).trim().slice(0, 200),
      target:   title.slice(sep + 3).trim().slice(0, 200),
    };
  }
  const sep2 = title.indexOf('/');
  if (sep2 !== -1) {
    return {
      acquirer: title.slice(0, sep2).trim().slice(0, 200),
      target:   title.slice(sep2 + 1).trim().slice(0, 200),
    };
  }
  return { acquirer: title.trim().slice(0, 200), target: null };
}

async function runUkCompaniesHouse(stats) {
  const url = 'https://api.company-information.service.gov.uk/advanced-search/companies?company_status=active&company_type=plc&size=100';

  console.log('[EU] Fetching UK Companies House PLC list');

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    console.error('[EU] Failed to fetch UK Companies House:', err.message);
    stats.failed++;
    return;
  }

  if (!data || !Array.isArray(data.items)) {
    console.log('[EU] UK Companies House: no items returned');
    return;
  }

  console.log(`[EU] UK Companies House returned ${data.items.length} companies`);
  stats.fetched += data.items.length;

  for (const item of data.items) {
    try {
      const result = await processUkCompany(item);
      if (result === 'new') stats.new++;
    } catch (err) {
      stats.failed++;
      console.error('[EU] Error processing UK company:', err.message);
    }
  }
}

async function processUkCompany(item) {
  const companyNumber = item.company_number || '';
  const companyName   = item.company_name   || '';
  if (!companyNumber || !companyName) return 'skip';

  const sourceUrl = trunc(
    `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`,
    500
  );

  const existing = await db.query(
    'SELECT id FROM companies WHERE normalized_name = $1 LIMIT 1',
    [trunc(normalizeName(companyName), 500)]
  );
  if (existing.rows.length > 0) return 'skip';

  await upsertCompany(db, { name: companyName }, null);
  return 'new';
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseDateFlexible(str) {
  if (!str) return null;
  const ddmmyyyy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(str.trim());
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}`;
  }
  const yyyymmdd = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(str.trim());
  if (yyyymmdd) {
    return `${yyyymmdd[1]}-${yyyymmdd[2].padStart(2, '0')}-${yyyymmdd[3].padStart(2, '0')}`;
  }
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch {}
  return null;
}

function trunc(str, len) {
  return str ? String(str).slice(0, len) : str;
}

function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|plc|co|company|corporation|incorporated|limited|sa|ag|nv|bv|se)\b/g, '')
    .trim();
}

async function upsertCompany(db, info, cik) {
  const name       = (info && info.name) ? info.name : 'Unknown';
  const normalized = normalizeName(name);

  if (cik) {
    const byCik = await db.query('SELECT id FROM companies WHERE cik = $1 LIMIT 1', [cik]);
    if (byCik.rows.length) return byCik.rows[0];
  }

  const byName = await db.query(
    'SELECT id FROM companies WHERE normalized_name = $1 LIMIT 1',
    [trunc(normalized, 500)]
  );
  if (byName.rows.length) return byName.rows[0];

  const res = await db.query(
    `INSERT INTO companies (name, normalized_name, cik)
     VALUES ($1, $2, $3) RETURNING id`,
    [trunc(name, 500), trunc(normalized, 500), cik || null]
  );
  return res.rows[0];
}

async function insertDeal(db, info) {
  const res = await db.query(`
    INSERT INTO deals (
      acquirer_id, target_id, headline, deal_type, status,
      announcement_date, filing_date, deal_value, sector,
      source_confidence, extraction_method, needs_review
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    info.acquirer_id,
    info.target_id         || null,
    trunc(info.headline, 500),
    trunc(info.deal_type, 100),
    trunc(info.status, 50),
    info.announcement_date || null,
    info.filing_date       || null,
    info.deal_value        || null,
    trunc(info.sector, 100) || null,
    info.source_confidence,
    trunc(info.extraction_method, 100),
    info.needs_review,
  ]);

  const dealId = res.rows[0].id;

  await db.query(`
    INSERT INTO deal_sources (deal_id, source_type, source_name, source_url, source_date)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    dealId,
    trunc(info.source_type, 50),
    trunc(info.source_name, 100),
    trunc(info.source_url, 500),
    info.source_date || null,
  ]);

  return dealId;
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

function fetchText(url, redirectDepth) {
  redirectDepth = redirectDepth || 0;
  if (redirectDepth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client    = parsedUrl.protocol === 'https:' ? https : http;
    const options   = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'mergers.news contact@mergers.news',
        'Accept':     'text/html, application/xhtml+xml, application/json, */*',
      },
    };
    const req = client.get(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
        res.resume();
        return fetchText(location, redirectDepth + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url) {
  return fetchText(url).then(text => {
    try { return JSON.parse(text); } catch { return null; }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { run };

if (require.main === module) {
  run().catch(console.error);
}
