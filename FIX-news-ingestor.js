'use strict';

/**
 * Press-release/RSS M&A ingestion.
 *
 * This source is intentionally a candidate source only. Every inserted record
 * remains needs_review=true and must pass strict-control-v3 before publication.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const extractionPath = fs.existsSync(path.join(__dirname, '../shared/deal-extraction.js'))
  ? '../shared/deal-extraction'
  : './FIX-deal-extraction';
const { extractDeal, distinctParties, normalizeName, rawSnippet, withRetry } = require(extractionPath);

const sourceUrlPath = fs.existsSync(path.join(__dirname, '../shared/source-url.js'))
  ? '../shared/source-url'
  : './FIX-source-url';
const { resolvePrimaryHttpUrl } = require(sourceUrlPath);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true },
  max: 4,
  statement_timeout: 60000,
});

db.on('error', error => console.error('[NEWS] idle DB client error:', error.message));

const RSS_FEEDS = [
  { name: 'GlobeNewswire M&A', url: 'https://www.globenewswire.com/RssFeed/subjectcode/30-Merger,Acquisitions' },
  { name: 'PR Newswire M&A', url: 'https://www.prnewswire.com/rss/news-releases-list.rss?category=mergers-acquisitions-alliances' },
  { name: 'Business Wire M&A', url: 'https://feed.businesswire.com/rss/home/?rss=G22' },
];

const EXCLUDE_RE = /\b(?:minority investment|minority stake|non-controlling stake|strategic investment|joint venture|partnership|series [a-f]|seed round|funding round|credit facility|refinanc(?:ing|e)|share buyback|stock buyback|repurchase|initial public offering|\bipo\b|license agreement|licensing agreement|distribution agreement|supply agreement|wins contract|contract award)\b/i;
const CONTROL_HINT_RE = /\b(?:agreed to acquire|agrees to acquire|to acquire|acquires|acquisition of|to be acquired by|merger with|to merge with|merger agreement|tender offer|going[- ]private|take[- ]private|scheme of arrangement|recommended (?:cash )?offer|buyout of)\b/i;

function trunc(value, length) {
  return value == null ? value : String(value).slice(0, length);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function extractTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function stripHtml(value) {
  return decodeXml(value)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    const block = match[1];
    const title = stripHtml(extractTag(block, 'title'));
    const description = stripHtml(extractTag(block, 'description'));
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    if (title || link) items.push({ title, description, link, pubDate });
  }
  return items;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'mergers.news contact@mergers.news',
      Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const body = await response.text();
  if (!/<(?:rss|feed|item)\b/i.test(body)) throw new Error(`Non-RSS response from ${url}`);
  return body;
}

function candidateFromItem(item) {
  const combined = `${item.title || ''}. ${item.description || ''}`.replace(/\s+/g, ' ').trim();
  if (!combined || EXCLUDE_RE.test(combined) || !CONTROL_HINT_RE.test(combined)) return null;
  const extracted = extractDeal(combined, { sourceReliability: 12, dedupCertainty: 2 });
  if (!distinctParties(extracted.acquirer, extracted.target)) return null;
  if (extracted.disposition === 'rejected') return null;
  return { combined, extracted };
}

async function upsertCompany(client, name) {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error(`Invalid company name: ${name}`);
  const existing = await client.query('SELECT id FROM companies WHERE normalized_name=$1 ORDER BY id LIMIT 1', [trunc(normalized, 500)]);
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    'INSERT INTO companies(name,normalized_name) VALUES($1,$2) RETURNING id',
    [trunc(name, 500), trunc(normalized, 500)]
  );
  return inserted.rows[0].id;
}

async function processItem(item, feedName) {
  const candidate = candidateFromItem(item);
  if (!candidate) return 'skip';

  const sourceUrl = trunc(await resolvePrimaryHttpUrl(item.link || '') || item.link || '', 500);
  if (!sourceUrl) return 'skip';
  const duplicate = await db.query('SELECT 1 FROM deal_sources WHERE source_url=$1 LIMIT 1', [sourceUrl]);
  if (duplicate.rows.length) return 'skip';

  const { extracted, combined } = candidate;
  const announcementDate = parseDate(item.pubDate) || new Date().toISOString().slice(0, 10);
  const valueCents = extracted.value ? Math.round(Number(extracted.value) * 100) : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const acquirerId = await upsertCompany(client, extracted.acquirer);
    const targetId = await upsertCompany(client, extracted.target);
    const deal = await client.query(`
      INSERT INTO deals(
        acquirer_id,target_id,headline,deal_type,status,announcement_date,filing_date,
        deal_value,per_share_value,premium_pct,sector,source_confidence,extraction_method,
        needs_review,extracted_acquirer_name,extracted_target_name,raw_extracted_snippet
      ) VALUES($1,$2,$3,$4,'Announced',$5,NULL,$6,$7,$8,NULL,$9,'news_rss',true,$10,$11,$12)
      RETURNING id
    `, [
      acquirerId,targetId,trunc(item.title || combined, 500),
      extracted.dealType || 'Acquisition',announcementDate,valueCents,
      extracted.perShare || null,extracted.premium || null,
      Math.max(0.55, Math.min(0.8, Number(extracted.confidence) || 0.55)),
      extracted.acquirer,extracted.target,rawSnippet(combined),
    ]);
    await client.query(`
      INSERT INTO deal_sources(deal_id,source_type,source_name,source_url,source_date,raw_content,confidence)
      VALUES($1,'news_rss',$2,$3,$4,$5,$6)
    `, [
      deal.rows[0].id,trunc(feedName, 100),sourceUrl,announcementDate,
      rawSnippet(combined),Math.max(0.55, Math.min(0.8, Number(extracted.confidence) || 0.55)),
    ]);
    await client.query('COMMIT');
    return 'new';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function startLog() {
  const result = await db.query("INSERT INTO ingestion_log(source,run_started_at,status) VALUES('news_rss',NOW(),'running') RETURNING id");
  return result.rows[0].id;
}

async function endLog(id, status, stats, errorMessage) {
  await db.query(`
    UPDATE ingestion_log SET run_ended_at=NOW(),status=$1,records_fetched=$2,
      records_new=$3,records_updated=0,records_failed=$4,error_message=$5
    WHERE id=$6
  `, [status, stats.fetched, stats.new, stats.failed, errorMessage || null, id]);
}

async function run() {
  const logId = await startLog();
  const stats = { fetched: 0, new: 0, failed: 0, feedsSucceeded: 0, feedsFailed: 0 };
  const feedErrors = [];
  try {
    for (const feed of RSS_FEEDS) {
      try {
        const xml = await withRetry(() => fetchFeed(feed.url), { attempts: 3, baseDelayMs: 1000 });
        const items = parseRssItems(xml);
        if (!items.length) throw new Error('Feed parsed zero RSS items');
        stats.feedsSucceeded++;
        stats.fetched += items.length;
        for (const item of items) {
          try {
            if (await processItem(item, feed.name) === 'new') stats.new++;
          } catch (error) {
            stats.failed++;
            console.error(`[NEWS] ${trunc(item.title, 80)}: ${error.message}`);
          }
        }
      } catch (error) {
        stats.feedsFailed++;
        feedErrors.push(`${feed.name}: ${error.message}`);
        console.error('[NEWS]', feedErrors[feedErrors.length - 1]);
      }
      await sleep(750);
    }

    if (!stats.feedsSucceeded) throw new Error(`All RSS feeds failed (${feedErrors.join('; ')})`);
    await endLog(logId, 'success', stats, feedErrors.length ? feedErrors.join('; ').slice(0, 1000) : null);
    console.log('[NEWS] Complete', stats);
    return stats;
  } catch (error) {
    await endLog(logId, 'failed', stats, error.message).catch(() => {});
    throw error;
  }
}

module.exports = { run, parseRssItems, candidateFromItem };

if (require.main === module) {
  run()
    .then(() => db.end())
    .catch(async error => {
      console.error('[NEWS] Fatal:', error);
      await db.end().catch(() => {});
      process.exitCode = 1;
    });
}
