'use strict';

const https    = require('https');
const http     = require('http');
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const RSS_FEEDS = [
  {
    name: 'GlobeNewswire M&A',
    url:  'https://www.globenewswire.com/RssFeed/subjectcode/30-Merger,Acquisitions',
  },
  {
    name: 'PR Newswire M&A',
    url:  'https://www.prnewswire.com/rss/news-releases-list.rss?category=mergers-acquisitions-alliances',
  },
  {
    name: 'Reuters Business',
    url:  'https://feeds.reuters.com/reuters/businessNews',
  },
  {
    name: 'Business Wire M&A',
    url:  'https://feed.businesswire.com/rss/home/?rss=G7&rssid=20899abb-18e7-4e0f-a4f2-77a5c4c9a6e8',
  },
];

const MA_KEYWORDS = [
  'acquires', 'acquisition', 'merger', 'takeover',
  'to buy', 'agrees to buy', 'to merge', 'bid for',
  'tender offer', 'going private', 'going-private',
];

const ENTITY_PATTERNS = [
  /^(.+?)\s+(?:agrees\s+to\s+buy|to\s+acquire)\s+(.+?)\s+for\s+\$[\d,.]+/i,
  /^(.+?)\s+acquires\s+(.+?)(?:\s+for\s+\$[\d,.]+)?$/i,
  /^(.+?)\s+and\s+(.+?)\s+to\s+merge/i,
  /^(.+?)\s+launches\s+bid\s+for\s+(.+?)(?:\s|$)/i,
  /^(.+?)\s+agrees\s+to\s+buy\s+(.+?)(?:\s+for\s+\$[\d,.]+)?$/i,
];

async function run() {
  const logId = await startLog('news_rss');
  const stats  = { fetched: 0, new: 0, updated: 0, failed: 0 };

  try {
    console.log('[NEWS] Starting ingestion run at', new Date().toISOString());

    for (const feed of RSS_FEEDS) {
      console.log(`[NEWS] Fetching feed: ${feed.name}`);
      try {
        const xml   = await fetchText(feed.url);
        const items = parseRssItems(xml);
        console.log(`[NEWS] Parsed ${items.length} items from ${feed.name}`);
        stats.fetched += items.length;

        for (const item of items) {
          try {
            if (!isMaDeal(item)) continue;
            const result = await processNewsItem(item, feed.name);
            if (result === 'new') stats.new++;
          } catch (err) {
            stats.failed++;
            console.error(`[NEWS] Error processing item "${trunc(item.title, 80)}":`, err.message);
          }
        }
      } catch (err) {
        stats.failed++;
        console.error(`[NEWS] Error fetching ${feed.name}:`, err.message);
      }

      await sleep(1500);
    }

    await endLog(logId, 'success', stats);
    console.log('[NEWS] Run complete:', stats);
  } catch (err) {
    await endLog(logId, 'failed', stats, err.message);
    console.error('[NEWS] Fatal error:', err);
  }
}

function parseRssItems(xml) {
  if (!xml) return [];
  const items    = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title:       extractTag(block, 'title'),
      link:        extractTag(block, 'link'),
      pubDate:     extractTag(block, 'pubDate'),
      description: extractTag(block, 'description'),
    });
  }

  return items;
}

function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cdata   = cdataRe.exec(xml);
  if (cdata) return cdata[1].trim();
  const plain   = plainRe.exec(xml);
  if (plain)  return plain[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return '';
}

function isMaDeal(item) {
  const text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
  return MA_KEYWORDS.some(kw => text.includes(kw));
}

async function processNewsItem(item, feedName) {
  const sourceUrl = trunc(item.link || '', 500);
  if (!sourceUrl) return 'skip';

  const existing = await db.query(
    'SELECT id FROM deal_sources WHERE source_url = $1 LIMIT 1',
    [sourceUrl]
  );
  if (existing.rows.length > 0) return 'skip';

  const { acquirer, target } = extractEntities(item.title || '');
  const dealValue            = extractDealValue((item.title || '') + ' ' + (item.description || ''));
  const pubDate              = parseDateFlexible(item.pubDate);

  const acquirerRec = await upsertCompany(db, { name: acquirer || 'Unknown' }, null);
  const targetRec   = target
    ? await upsertCompany(db, { name: target }, null)
    : null;

  await insertDeal(db, {
    acquirer_id:       acquirerRec.id,
    target_id:         targetRec ? targetRec.id : null,
    headline:          trunc(item.title || `${acquirer} / ${target}`, 500),
    deal_type:         inferDealType(item.title || ''),
    status:            'Announced',
    announcement_date: pubDate,
    filing_date:       null,
    deal_value:        dealValue,
    sector:            null,
    source_confidence: 0.5,
    extraction_method: 'news_rss',
    needs_review:      true,
    source_type:       'news_rss',
    source_name:       feedName,
    source_url:        sourceUrl,
    source_date:       pubDate,
  });

  return 'new';
}

function extractEntities(title) {
  for (const pattern of ENTITY_PATTERNS) {
    const m = pattern.exec(title);
    if (m) {
      return {
        acquirer: cleanCompanyName(m[1]),
        target:   cleanCompanyName(m[2]),
      };
    }
  }
  return { acquirer: null, target: null };
}

function cleanCompanyName(name) {
  if (!name) return null;
  return name.replace(/^\s+|\s+$/g, '').replace(/\s{2,}/g, ' ').slice(0, 200) || null;
}

function extractDealValue(text) {
  const m = /(\d[\d,.]*)\s*(billion|million|bn|mn|B\b|M\b)/i.exec(text);
  if (!m) return null;
  const num  = parseFloat(m[1].replace(/,/g, ''));
  const unit = m[2].toLowerCase();
  if (unit === 'billion' || unit === 'bn' || unit === 'b') return Math.round(num * 1e9 * 100);
  if (unit === 'million' || unit === 'mn' || unit === 'm') return Math.round(num * 1e6 * 100);
  return null;
}

function inferDealType(title) {
  const t = title.toLowerCase();
  if (/tender\s+offer/.test(t))                                      return 'Tender Offer';
  if (/going.private/.test(t))                                       return 'Going-Private';
  if (/merger|to\s+merge/.test(t))                                   return 'Merger';
  if (/acquires|acquisition|to\s+buy|agrees\s+to\s+buy/.test(t))    return 'Acquisition';
  return 'Merger';
}

function parseDateFlexible(str) {
  if (!str) return null;
  const ddmmyyyy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(str.trim());
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}`;
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
    const parsedUrl = new (require('url').URL)(url);
    const client    = parsedUrl.protocol === 'https:' ? https : http;
    const options   = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'mergers.news contact@mergers.news',
        'Accept':     'application/rss+xml, application/xml, text/xml, text/html, */*',
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
      res.on('data', chunk => chunks.push(chunk));
      res.on('end',  ()    => resolve(Buffer.concat(chunks).toString('utf8')));
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
