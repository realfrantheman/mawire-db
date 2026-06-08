'use strict';

const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
});

const APAC_MA_KEYWORDS = [
  'takeover', 'merger', 'acquisition', 'offer',
  'scheme of arrangement', 'privatization', 'privatisation',
  'acquires', 'to acquire', 'to merge', 'bid for',
  'tender offer', 'going private', 'going-private',
];

async function run() {
  const logId = await startLog('apac');
  const stats  = { fetched: 0, new: 0, updated: 0, failed: 0 };

  try {
    console.log('[APAC] Starting ingestion run at', new Date().toISOString());

    await runHkex(stats);
    await sleep(2000);
    await runAsx(stats);
    await sleep(2000);
    await runSgx(stats);

    await endLog(logId, 'success', stats);
    console.log('[APAC] Run complete:', stats);
  } catch (err) {
    await endLog(logId, 'failed', stats, err.message);
    console.error('[APAC] Fatal error:', err);
  }
}

function hkexListUrl(yyyymmdd) {
  const year = yyyymmdd.slice(0, 4);
  const mmdd = yyyymmdd.slice(4, 8);
  return `https://www.hkexnews.hk/listedco/listconews/sehk/${year}/${mmdd}/LIST.HTM`;
}

async function runHkex(stats) {
  const dates = [todayStr(), yesterdayStr()];
  console.log('[APAC/HKEX] Fetching announcements for', dates.join(', '));

  for (const dateStr of dates) {
    try {
      const url  = hkexListUrl(dateStr);
      const html = await fetchText(url);
      const announcements = parseHkexAnnouncements(html, dateStr);

      console.log(`[APAC/HKEX] Found ${announcements.length} M&A announcements on ${dateStr}`);
      stats.fetched += announcements.length;

      for (const ann of announcements) {
        try {
          const result = await processHkexAnnouncement(ann);
          if (result === 'new') stats.new++;
        } catch (err) {
          stats.failed++;
          console.error(`[APAC/HKEX] Error processing announcement "${trunc(ann.title, 80)}":`, err.message);
        }
      }
    } catch (err) {
      stats.failed++;
      console.error(`[APAC/HKEX] Error fetching date ${dateStr}:`, err.message);
    }

    await sleep(1500);
  }
}

function parseHkexAnnouncements(html, dateStr) {
  if (!html) return [];
  const results = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    const linkMatch = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!linkMatch) continue;

    const href  = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();

    if (!title || !isMaKeyword(title)) continue;

    const cells = [];
    const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(stripHtml(tdMatch[1]).trim());
    }

    const companyName = cells[0] || '';
    const fullUrl     = href.startsWith('http')
      ? href
      : `https://www1.hkexnews.hk${href.startsWith('/') ? '' : '/'}${href}`;

    results.push({
      title:       title,
      companyName: companyName,
      url:         fullUrl,
      dateStr:     dateStr,
      dealType:    inferApacDealType(title),
    });
  }

  return results;
}

async function processHkexAnnouncement(ann) {
  const sourceUrl = trunc(ann.url, 500);
  if (!sourceUrl) return 'skip';

  const existing = await db.query(
    'SELECT id FROM deal_sources WHERE source_url = $1 LIMIT 1',
    [sourceUrl]
  );
  if (existing.rows.length > 0) return 'skip';

  const companyName = ann.companyName || extractCompanyFromTitle(ann.title) || 'Unknown';
  const companyRec  = await upsertCompany(db, { name: companyName }, null);
  const annoDate    = parseDateFromYYYYMMDD(ann.dateStr);

  await insertDeal(db, {
    acquirer_id:       companyRec.id,
    target_id:         null,
    headline:          trunc(ann.title, 500),
    deal_type:         ann.dealType,
    status:            'Announced',
    announcement_date: annoDate,
    filing_date:       annoDate,
    deal_value:        null,
    sector:            'Asia Pacific',
    source_confidence: 0.7,
    extraction_method: 'hkex_html',
    needs_review:      true,
    source_type:       'hkex',
    source_name:       'HKEX News',
    source_url:        sourceUrl,
    source_date:       annoDate,
  });

  return 'new';
}

async function runAsx(stats) {
  console.log('[APAC/ASX] Fetching ASX announcements');

  const MA_TYPES = ['Takeover Bid', 'Merger', 'Scheme of Arrangement', 'Off-market Takeover'];

  const url  = 'https://announcements.asx.com.au/asxannouncements.asx';

  let html;
  try {
    html = await fetchText(url);
  } catch (err) {
    console.error('[APAC/ASX] Failed to fetch ASX announcements:', err.message);
    stats.failed++;
    return;
  }

  const announcements = parseAsxAnnouncements(html, MA_TYPES);
  console.log(`[APAC/ASX] Found ${announcements.length} M&A announcements`);
  stats.fetched += announcements.length;

  for (const ann of announcements) {
    try {
      const result = await processAsxAnnouncement(ann);
      if (result === 'new') stats.new++;
    } catch (err) {
      stats.failed++;
      console.error(`[APAC/ASX] Error processing announcement "${trunc(ann.title, 80)}":`, err.message);
    }
  }
}

function parseAsxAnnouncements(html, maTypes) {
  if (!html) return [];
  const results = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row   = rowMatch[1];
    const cells = [];
    const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;

    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(stripHtml(tdMatch[1]).trim());
    }

    if (cells.length < 2) continue;

    const rowText = cells.join(' ').toLowerCase();
    const isMA    = maTypes.some(t => rowText.includes(t.toLowerCase())) || isMaKeyword(rowText);
    if (!isMA) continue;

    const linkMatch = /<a[^>]+href=["']([^"']+)["'][^>]*>/i.exec(row);
    const href      = linkMatch ? linkMatch[1] : '';
    const fullUrl   = href.startsWith('http')
      ? href
      : href
        ? `https://announcements.asx.com.au${href.startsWith('/') ? '' : '/'}${href}`
        : '';

    const title    = cells[1] || cells[0] || rowText.slice(0, 200);
    const ticker   = cells[0] || '';
    const dateStr  = cells[cells.length - 1] || '';

    results.push({
      title:    title,
      ticker:   ticker,
      url:      fullUrl,
      dateStr:  dateStr,
      dealType: inferApacDealType(title + ' ' + rowText),
    });
  }

  return results;
}

async function processAsxAnnouncement(ann) {
  const sourceUrl = trunc(ann.url || `https://announcements.asx.com.au/?ticker=${ann.ticker}&t=${Date.now()}`, 500);

  const existing = await db.query(
    'SELECT id FROM deal_sources WHERE source_url = $1 LIMIT 1',
    [sourceUrl]
  );
  if (existing.rows.length > 0) return 'skip';

  const companyName = ann.ticker ? `${ann.ticker} (ASX)` : extractCompanyFromTitle(ann.title) || 'Unknown';
  const companyRec  = await upsertCompany(db, { name: companyName }, null);
  const annoDate    = parseDateFlexible(ann.dateStr);
  const dealValue   = extractDealValue(ann.title);

  await insertDeal(db, {
    acquirer_id:       companyRec.id,
    target_id:         null,
    headline:          trunc(ann.title, 500),
    deal_type:         ann.dealType,
    status:            'Announced',
    announcement_date: annoDate,
    filing_date:       annoDate,
    deal_value:        dealValue,
    sector:            'Asia Pacific',
    source_confidence: 0.7,
    extraction_method: 'asx_html',
    needs_review:      true,
    source_type:       'asx',
    source_name:       'ASX Announcements',
    source_url:        sourceUrl,
    source_date:       annoDate,
  });

  return 'new';
}

async function runSgx(stats) {
  console.log('[APAC/SGX] Fetching SGX company announcements');

  const url = 'https://www.sgx.com/securities/company-announcements';

  let html;
  try {
    html = await fetchText(url);
  } catch (err) {
    console.error('[APAC/SGX] Failed to fetch SGX announcements:', err.message);
    stats.failed++;
    return;
  }

  const announcements = parseSgxAnnouncements(html);
  console.log(`[APAC/SGX] Found ${announcements.length} M&A announcements`);
  stats.fetched += announcements.length;

  for (const ann of announcements) {
    try {
      const result = await processSgxAnnouncement(ann);
      if (result === 'new') stats.new++;
    } catch (err) {
      stats.failed++;
      console.error(`[APAC/SGX] Error processing announcement "${trunc(ann.title, 80)}":`, err.message);
    }
  }
}

function parseSgxAnnouncements(html) {
  if (!html) return [];
  const results = [];

  const entryRegex = /<(?:tr|div|li)[^>]*>([\s\S]*?)<\/(?:tr|div|li)>/gi;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(html)) !== null) {
    const block = entryMatch[1];
    const text  = stripHtml(block).trim();

    if (!text || !isMaKeyword(text)) continue;

    const linkMatch = /<a[^>]+href=["']([^"']+)["'][^>]*>/i.exec(block);
    const href      = linkMatch ? linkMatch[1] : '';
    const fullUrl   = href.startsWith('http')
      ? href
      : href
        ? `https://www.sgx.com${href.startsWith('/') ? '' : '/'}${href}`
        : '';

    if (!fullUrl) continue;

    const alreadyAdded = results.some(r => r.url === fullUrl);
    if (alreadyAdded) continue;

    results.push({
      title:    trunc(text, 300),
      url:      fullUrl,
      dealType: inferApacDealType(text),
    });
  }

  return results;
}

async function processSgxAnnouncement(ann) {
  const sourceUrl = trunc(ann.url, 500);
  if (!sourceUrl) return 'skip';

  const existing = await db.query(
    'SELECT id FROM deal_sources WHERE source_url = $1 LIMIT 1',
    [sourceUrl]
  );
  if (existing.rows.length > 0) return 'skip';

  const companyName = extractCompanyFromTitle(ann.title) || 'Unknown';
  const companyRec  = await upsertCompany(db, { name: companyName }, null);
  const dealValue   = extractDealValue(ann.title);
  const today       = new Date().toISOString().split('T')[0];

  await insertDeal(db, {
    acquirer_id:       companyRec.id,
    target_id:         null,
    headline:          trunc(ann.title, 500),
    deal_type:         ann.dealType,
    status:            'Announced',
    announcement_date: today,
    filing_date:       today,
    deal_value:        dealValue,
    sector:            'Asia Pacific',
    source_confidence: 0.65,
    extraction_method: 'sgx_html',
    needs_review:      true,
    source_type:       'sgx',
    source_name:       'SGX Company Announcements',
    source_url:        sourceUrl,
    source_date:       today,
  });

  return 'new';
}

function isMaKeyword(text) {
  const t = text.toLowerCase();
  return APAC_MA_KEYWORDS.some(kw => t.includes(kw));
}

function inferApacDealType(text) {
  const t = (text || '').toLowerCase();
  if (/scheme\s+of\s+arrangement/.test(t))                          return 'Merger';
  if (/tender\s+offer|off.market\s+takeover/.test(t))               return 'Tender Offer';
  if (/going.private|privatiz|privatis/.test(t))                    return 'Going-Private';
  if (/takeover|bid\s+for/.test(t))                                 return 'Acquisition';
  if (/merger|to\s+merge/.test(t))                                  return 'Merger';
  if (/acquires|acquisition|to\s+acquire/.test(t))                  return 'Acquisition';
  return 'Acquisition';
}

function extractCompanyFromTitle(title) {
  if (!title) return null;
  const m = /^([A-Z][A-Za-z0-9\s&,.'()-]{2,60}?)(?:\s+[-–—:]\s+|\s+to\s+|\s+acqui|\s+launch|\s+bid\s)/i.exec(title);
  if (m) return m[1].trim().slice(0, 200);
  return title.split(/[-–—:]/)[0].trim().slice(0, 200) || null;
}

function extractDealValue(text) {
  if (!text) return null;
  const m = /(\d[\d,.]*)\s*(billion|million|bn|mn|B\b|M\b)/i.exec(text);
  if (!m) return null;
  const num  = parseFloat(m[1].replace(/,/g, ''));
  const unit = m[2].toLowerCase();
  if (unit === 'billion' || unit === 'bn' || unit === 'b') return Math.round(num * 1e9 * 100);
  if (unit === 'million' || unit === 'mn' || unit === 'm') return Math.round(num * 1e6 * 100);
  return null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function parseDateFromYYYYMMDD(str) {
  if (!str || str.length !== 8) return null;
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
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

function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
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
