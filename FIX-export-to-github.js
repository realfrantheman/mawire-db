/**
 * mergers.news — verified public database export
 * Exports the strict transaction-review population from PostgreSQL.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const sourceUrlPath = fs.existsSync(path.join(__dirname, '../services/shared/source-url.js'))
  ? '../services/shared/source-url'
  : './FIX-source-url';
const { canonicalPrimarySourceUrl, secSubmissionUrl, isDirectSecArchiveFile } = require(sourceUrlPath);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 4,
  statement_timeout: 120000,
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.MAWIRE_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'realfrantheman/mawire-db';
const GITHUB_FILE = process.env.GITHUB_FILE || 'deals.json';
const TRANSACTION_REVIEW_RULE_VERSION = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';

function normalizeIdentityPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isReliableEntity(value) {
  return !!value && !/^(unknown|undisclosed|n\/a|null)|see filing/i.test(String(value).trim());
}

function isSpecificSourceUrl(value) {
  if (!value) return false;
  return !/sec\.gov\/cgi-bin\/browse-edgar|efts\.sec\.gov\/LATEST\/search-index|-index\.html(?:[?#]|$)/i.test(String(value));
}

function isPublishableDeal(deal) {
  const lowConfidenceNews = deal.sourceType === 'news_rss' && Number(deal.confidence) <= 0.5;
  const promotionalTarget = /,\s+(?:bringing|creating|expanding|accelerating|transforming|strengthening)\b/i.test(String(deal.target || ''));
  return !(lowConfidenceNews && promotionalTarget);
}

function identityKeys(deal) {
  const keys = [];
  if (deal.accessionNo) keys.push(`accession:${normalizeIdentityPart(deal.accessionNo)}`);
  if (isSpecificSourceUrl(deal.sourceUrl)) keys.push(`source:${deal.sourceUrl.replace(/[?#].*$/, '').toLowerCase()}`);
  if (isReliableEntity(deal.acquirer) && isReliableEntity(deal.target) && deal.dateISO) {
    keys.push(`parties:${normalizeIdentityPart(deal.acquirer)}|${normalizeIdentityPart(deal.target)}|${String(deal.dateISO).slice(0, 10)}|${normalizeIdentityPart(deal.dealType)}`);
  } else if ((isReliableEntity(deal.acquirer) || isReliableEntity(deal.target)) && deal.dateISO) {
    const acquirer = isReliableEntity(deal.acquirer) ? deal.acquirer : '';
    const target = isReliableEntity(deal.target) ? deal.target : '';
    keys.push(`partial:${normalizeIdentityPart(acquirer)}|${normalizeIdentityPart(target)}|${String(deal.dateISO).slice(0, 10)}`);
  }
  if (deal.headline && deal.dateISO && !/^(unknown|undisclosed)|see filing/i.test(deal.headline)) {
    keys.push(`headline:${normalizeIdentityPart(deal.headline)}|${String(deal.dateISO).slice(0, 10)}`);
  }
  return keys;
}

function recordScore(deal) {
  let score = 0;
  if (deal.sourceUrl) score += 3;
  if (deal.filingType) score += 2;
  if (isReliableEntity(deal.acquirer)) score += 2;
  if (isReliableEntity(deal.target)) score += 2;
  if (deal.dealValue && deal.dealValue !== 'Undisclosed') score += 2;
  if (deal.edgarUrl) score += 1;
  return score;
}

function deduplicateDeals(deals) {
  const output = [];
  const keyToIndex = new Map();
  for (const deal of deals) {
    if (!isPublishableDeal(deal)) continue;
    if (!isReliableEntity(deal.acquirer) && !isReliableEntity(deal.target)) continue;
    const keys = identityKeys(deal);
    const existingIndex = keys.map(key => keyToIndex.get(key)).find(index => index !== undefined);
    if (existingIndex === undefined) {
      const index = output.push(deal) - 1;
      keys.forEach(key => keyToIndex.set(key, index));
      continue;
    }
    if (recordScore(deal) > recordScore(output[existingIndex])) output[existingIndex] = deal;
    keys.forEach(key => keyToIndex.set(key, existingIndex));
  }
  return output;
}

async function run() {
  console.log('[EXPORT] Fetching verified deals from PostgreSQL...');
  const res = await db.query(`
    SELECT
      d.id,d.headline,
      a.name AS acquirer,t.name AS target,
      d.extracted_acquirer_name AS "extractedAcquirer",
      d.extracted_target_name AS "extractedTarget",
      d.deal_type AS "dealType",d.status,d.deal_value AS "dealValueCents",
      CASE
        WHEN d.deal_value >= 100000000000000 THEN '$' || ROUND(d.deal_value/100.0/1e12,1)::text || 'T'
        WHEN d.deal_value >= 100000000000 THEN '$' || ROUND(d.deal_value/100.0/1e9,1)::text || 'B'
        WHEN d.deal_value >= 100000000 THEN '$' || ROUND(d.deal_value/100.0/1e6,1)::text || 'M'
        WHEN d.deal_value IS NULL THEN 'Undisclosed'
        ELSE '$' || (d.deal_value/100.0)::text
      END AS "dealValue",
      d.per_share_value AS "perShare",d.premium_pct AS premium,
      d.sector,d.region,d.country,
      d.announcement_date AS "announcementDate",
      EXTRACT(YEAR FROM d.announcement_date)::int AS year,
      d.announcement_date::text AS "dateISO",
      d.close_date AS "closingDate",
      d.is_private_equity AS "isPrivateEquity",d.is_hostile AS "isHostile",
      d.ai_summary AS "aiSummary",d.source_confidence AS confidence,
      d.extraction_method AS "extractionMethod",
      tr.status AS "reviewStatus",tr.transaction_type AS "reviewedDealType",
      tr.rule_version AS "reviewRuleVersion",tr.evidence_url AS "reviewEvidenceUrl",
      tr.reviewed_at AS "reviewedAt",
      ds.source_type AS "sourceType",ds.source_name AS "sourceName",
      ds.source_url AS "sourceUrl",ds.source_date AS "sourceDate",
      f.filing_type AS "filingType",f.document_url AS "documentUrl",
      f.edgar_url AS "edgarUrl",f.accession_no AS "accessionNo",f.cik AS "filingCik"
    FROM deals d
    LEFT JOIN companies a ON d.acquirer_id=a.id
    LEFT JOIN companies t ON d.target_id=t.id
    JOIN deal_transaction_reviews tr
      ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version=$1
    LEFT JOIN LATERAL (
      SELECT source_type,source_name,source_url,source_date
      FROM deal_sources
      WHERE deal_id=d.id
      ORDER BY
        CASE source_type
          WHEN 'sec_edgar' THEN 100
          WHEN 'eu_merger_registry' THEN 95
          WHEN 'hkex' THEN 90
          WHEN 'asx' THEN 90
          WHEN 'sgx' THEN 90
          WHEN 'company_press_release' THEN 85
          WHEN 'news_rss' THEN 40
          WHEN 'gdelt' THEN 30
          ELSE 50
        END DESC,
        confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id
      LIMIT 1
    ) ds ON true
    LEFT JOIN LATERAL (
      SELECT filing_type,document_url,edgar_url,accession_no,cik
      FROM filings
      WHERE deal_id=d.id
      ORDER BY filing_date DESC NULLS LAST,created_at DESC,id
      LIMIT 1
    ) f ON true
    WHERE d.canonical_id IS NULL
    ORDER BY d.announcement_date DESC NULLS LAST,d.id
  `, [TRANSACTION_REVIEW_RULE_VERSION]);

  const now = new Date();
  const PLACEHOLDERS = new Set([
    'Acquirer (see filing)','Disclosed in filing','Public company target (see filing)',
    'Target (see filing)','Unknown',
  ]);

  const deals = res.rows.map(row => {
    const acquirer = cleanCompanyName(row.acquirer, PLACEHOLDERS) || cleanCompanyName(row.extractedAcquirer, PLACEHOLDERS);
    const target = cleanCompanyName(row.target, PLACEHOLDERS) || cleanCompanyName(row.extractedTarget, PLACEHOLDERS);
    const dealType = row.reviewedDealType || row.dealType || 'Merger';
    const headline = !row.headline || /see filing|^(unknown|undisclosed)/i.test(row.headline)
      ? `${acquirer || 'Unknown acquirer'} / ${target || 'Unknown target'}`
      : row.headline;
    const dateObj = row.announcementDate ? new Date(row.announcementDate) : null;
    const dateStr = dateObj ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const year = row.year || (dateObj ? dateObj.getFullYear() : null);
    const perShare = row.perShare !== null && row.perShare !== undefined ? `$${Number(row.perShare).toFixed(2)}` : null;
    // premium_pct is stored as a decimal fraction: 0.255 => 25.5%.
    const premium = row.premium !== null && row.premium !== undefined ? `${Math.round(Number(row.premium) * 1000) / 10}%` : null;
    const breaking = !!(year === now.getFullYear() && row.status === 'Announced');
    const dealValNum = row.dealValueCents === null || row.dealValueCents === undefined ? 0 : Number(row.dealValueCents) / 100;

    const source = resolveSourceName(row);
    const timeAgo = computeTimeAgo(dateObj, now);
    const era = computeEra(year);
    const subheadline = buildSubheadline(row, acquirer, target, dateStr);
    const body = row.aiSummary || buildBody(row, acquirer, target, dealType, dateStr, perShare);
    const summary = buildSummary(row, acquirer, target, dealType, dateStr, row.dealValue, body);
    const sourceUrl = isSpecificSourceUrl(row.reviewEvidenceUrl)
      ? row.reviewEvidenceUrl
      : canonicalPrimarySourceUrl(row);

    return {
      id: row.id,headline,subheadline,acquirer,extractedAcquirer: row.extractedAcquirer || null,
      target,extractedTarget: row.extractedTarget || null,dealType,status: row.status,
      dealValue: row.dealValue,dealValueNum: dealValNum,perShare,premium,
      sector: row.sector,region: row.region,country: row.country,date: dateStr,year,
      dateISO: row.dateISO,closingDate: row.closingDate,timeAgo,era,
      isPrivateEquity: row.isPrivateEquity || false,isHostile: row.isHostile || false,
      body,summary,source,sourceUrl,filingType: row.filingType,
      edgarUrl: canonicalPrimarySourceUrl(row) || reconstructEdgarUrl(row),
      extractionMethod: row.extractionMethod,sourceType: row.sourceType,sourceName: row.sourceName,
      accessionNo: row.accessionNo,confidence: row.confidence,
      reviewStatus: row.reviewStatus,reviewRuleVersion: row.reviewRuleVersion,reviewedAt: row.reviewedAt,
      breaking,advisors: null,
    };
  });

  const deduped = deduplicateDeals(deals);
  console.log(`[EXPORT] Deduped ${deals.length} → ${deduped.length} records (removed ${deals.length - deduped.length})`);
  if (!deduped.length) throw new Error('Verified export produced zero deals; refusing to publish');
  const invalid = deduped.filter(deal => !isReliableEntity(deal.acquirer) || !isReliableEntity(deal.target) || !isSpecificSourceUrl(deal.sourceUrl));
  if (invalid.length) throw new Error(`Verified export contains ${invalid.length} invalid public deal(s); refusing to publish`);

  const json = JSON.stringify(deduped, null, 2);
  if (process.env.LOCAL_ONLY === 'true') {
    fs.writeFileSync('deals.json', `${json}\n`);
    console.log('[EXPORT] Wrote', deduped.length, 'deals to local deals.json');
    return deduped;
  }

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN/MAWIRE_TOKEN is required for direct GitHub publication');
  const encoded = Buffer.from(json).toString('base64');
  const sha = await getFileSHA();
  await pushToGitHub(encoded, sha);
  console.log('[EXPORT] GitHub updated with', deduped.length, 'deals');
  return deduped;
}

const TICKER_RE = /\s*\([A-Z]{1,5}\)/g;
function cleanName(name) {
  return name ? name.replace(TICKER_RE, '').trim() : '';
}

function buildSummary(row, acquirerRaw, targetRaw, dealType, date, dealValue, body) {
  const source = resolveSourceName(row);
  if (source !== 'SEC Filing' && body) {
    const first = body.split(/(?<=[a-z])\.\s+(?=[A-Z])/)[0].replace(/\.$/, '');
    if (first && first.length > 30) return `${first}.`;
  }
  const acquirer = cleanName(acquirerRaw), target = cleanName(targetRaw);
  const val = dealValue && dealValue !== 'Undisclosed' ? dealValue : null;
  const valStr = val ? ` valued at ${val}` : '';
  const form = String(row.filingType || '').toUpperCase();
  const parties = acquirer && target ? `${acquirer} and ${target}` : (acquirer || target || 'The transaction parties');
  const datePhrase = date ? ` on ${date}` : '';
  if (form === 'SC TO-T' || form === 'SC TO-T/A') return `${parties} are the subject of a tender offer statement filed with the SEC${datePhrase}${valStr}.`;
  if (form === 'DEFM14A') return `${parties} are described in a definitive merger proxy statement filed with the SEC${datePhrase}${valStr}.`;
  if (form === 'PREM14A' || form === 'DEFA14A') return `${parties} are described in proxy materials filed with the SEC${datePhrase}${valStr}.`;
  if (form === 'S-4' || form === 'S-4/A') return `${parties} are described in an SEC registration statement concerning a proposed transaction${datePhrase}${valStr}.`;
  if (form === 'SC 13E-3' || form === 'SC 13E-3/A') return `${parties} are described in an SEC going-private transaction statement${datePhrase}${valStr}.`;
  if (source === 'SEC Filing') return `${parties} are described in an SEC filing${form ? ` (Form ${form})` : ''}${datePhrase}${valStr}.`;
  if (acquirer && target) return `${acquirer} announced a ${String(dealType || 'transaction').toLowerCase()} involving ${target}${valStr}${datePhrase}.`;
  return `${row.headline || 'Transaction'}${date ? ` — ${date}` : ''}.`;
}

function buildBody(row, acquirer, target, dealType, date) {
  const val = row.dealValue && row.dealValue !== 'Undisclosed' ? ` at ${row.dealValue}` : '';
  const form = String(row.filingType || '').toUpperCase();
  const source = resolveSourceName(row);
  const parties = [acquirer, target].filter(Boolean).join(' and ') || 'The transaction';
  if (source === 'SEC Filing') return `${parties} is documented in ${form ? `Form ${form}` : 'an SEC filing'}${date ? ` filed on ${date}` : ''}${val}. The source link points directly to the filing document.`;
  if (source === 'EU Merger Registry') return `${parties} is documented in the European Commission merger-control source${date ? ` dated ${date}` : ''}.`;
  if (/HKEX|ASX|SGX/.test(source)) return `${parties} is documented in a ${source} company announcement${date ? ` dated ${date}` : ''}.`;
  return `${parties} announced a ${String(dealType || 'transaction').toLowerCase()}${val}${date ? ` on ${date}` : ''}.`;
}

function buildSubheadline(row, acquirer, target, date) {
  const parts = [];
  const source = resolveSourceName(row);
  if (row.filingType) parts.push(`${row.filingType} ${source === 'SEC Filing' ? 'filed with SEC' : 'filing'}`);
  else if (source && source !== 'SEC Filing') parts.push(`via ${source}`);
  if (row.perShare !== null && row.perShare !== undefined) parts.push(`$${Number(row.perShare).toFixed(2)} per share`);
  if (row.dealValue && row.dealValue !== 'Undisclosed' && (row.perShare === null || row.perShare === undefined)) parts.push(row.dealValue);
  if (date) parts.push(date);
  if (!parts.length) {
    if (acquirer && target && acquirer !== 'Undisclosed' && target !== 'Undisclosed') return `${acquirer} / ${target}${date ? ` — ${date}` : ''}`;
    return date || '';
  }
  return parts.join(' — ');
}

function cleanCompanyName(name, placeholders) {
  if (!name || placeholders.has(name)) return 'Undisclosed';
  if (/^(?:BCP Investment Corp|EDGARFILINGS LTD|Toppan Merrill\/FA|.*(?:Filing Services|Filing Agent)|Donnelley Financial.*)$/i.test(String(name).trim())) return 'Undisclosed';
  return name
    .replace(/\s*\([A-Z]{1,5}\)\s*/g, ' ')
    .replace(/\s*\(CIK\s+\d+\)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Undisclosed';
}

function reconstructEdgarUrl(row) {
  const direct = firstDirectSecArchiveUrl(row.documentUrl, row.edgarUrl, row.sourceUrl);
  if (direct) return direct;
  const accession = String(row.accessionNo || '').split(':')[0].match(/\d{10}-\d{2}-\d{6}/)?.[0];
  return accession ? secSubmissionUrl(accession) : null;
}

function firstDirectSecArchiveUrl(...urls) {
  for (const url of urls) {
    if (isDirectSecArchiveFile(url)) return String(url).trim();
  }
  return null;
}

function resolveSourceName(row) {
  const method = row.extractionMethod || '';
  const type = row.sourceType || '';
  const name = row.sourceName || '';
  if (method === 'sec_filing' || type === 'sec_edgar') return 'SEC Filing';
  if (method === 'eu_merger_registry' || type === 'eu_merger_registry') return 'EU Merger Registry';
  if (method === 'news_rss' || type === 'news_rss') return name || 'News RSS';
  if (method === 'hkex' || /hkex/i.test(name)) return 'HKEX';
  if (method === 'asx' || /\basx\b/i.test(name)) return 'ASX';
  if (method === 'sgx' || /\bsgx\b/i.test(name)) return 'SGX';
  return name || 'Source';
}

function computeTimeAgo(dateObj, now) {
  if (!dateObj || Number.isNaN(dateObj.getTime())) return null;
  const diffDays = Math.floor((now - dateObj) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${diffDays < 14 ? '' : 's'} ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${diffDays < 60 ? '' : 's'} ago`;
  const years = Math.floor(diffDays / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function computeEra(year) {
  return year ? `${Math.floor(year / 10) * 10}s` : null;
}

async function githubRequest(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: pathName,
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'mergers-news-platform',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = {}; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        if (res.statusCode === 404 && method === 'GET') return resolve(null);
        reject(new Error(`GitHub API ${method} ${pathName} -> ${res.statusCode}: ${data.slice(0, 500)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFileSHA() {
  const current = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=main`);
  return current?.sha || null;
}

async function pushToGitHub(content, sha) {
  return githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
    message: `Update deals.json — ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {}),
    branch: 'main',
  });
}

async function close() {
  await db.end();
}

module.exports = {
  run,close,deduplicateDeals,identityKeys,isSpecificSourceUrl,isPublishableDeal,
  reconstructEdgarUrl,firstDirectSecArchiveUrl,recordScore,
};

if (require.main === module) {
  run()
    .then(() => close())
    .catch(async error => {
      console.error('[EXPORT] Fatal:', error.stack || error.message);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}
