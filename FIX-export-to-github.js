/**
 * mergers.news — GitHub Export Script
 * Exports deals from PostgreSQL → deals.json → GitHub
 * Generates summary, subheadline, timeAgo, era, source fields inline.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sourceUrlPath = fs.existsSync(path.join(__dirname, '../services/shared/source-url.js')) ? '../services/shared/source-url' : './FIX-source-url';
const { canonicalPrimarySourceUrl } = require(sourceUrlPath);

const https    = require('https');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true } });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO || 'realfrantheman/mawire-db';
const GITHUB_FILE  = process.env.GITHUB_FILE || 'deals.json';

function normalizeIdentityPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isReliableEntity(value) {
  return !!value && !/^(unknown|undisclosed|n\/a|null)|see filing/i.test(String(value).trim());
}

function isSpecificSourceUrl(value) {
  if (!value) return false;
  return !/sec\.gov\/cgi-bin\/browse-edgar|efts\.sec\.gov\/LATEST\/search-index/i.test(value);
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
  console.log('[EXPORT] Fetching deals from PostgreSQL...');

  const res = await db.query(`
    SELECT
      d.id,
      d.headline,
      a.name  AS acquirer,
      t.name  AS target,
      d.extracted_acquirer_name AS "extractedAcquirer",
      d.extracted_target_name AS "extractedTarget",
      d.deal_type        AS "dealType",
      d.status,
      d.deal_value       AS "dealValueCents",
      CASE
        WHEN d.deal_value >= 100000000000000 THEN '$' || ROUND(d.deal_value/100.0/1e12,1)::text || 'T'
        WHEN d.deal_value >= 100000000000    THEN '$' || ROUND(d.deal_value/100.0/1e9,1)::text  || 'B'
        WHEN d.deal_value >= 100000000       THEN '$' || ROUND(d.deal_value/100.0/1e6,1)::text  || 'M'
        WHEN d.deal_value IS NULL            THEN 'Undisclosed'
        ELSE '$' || (d.deal_value/100)::text
      END AS "dealValue",
      d.per_share_value  AS "perShare",
      d.premium_pct      AS premium,
      d.sector,
      d.region,
      d.country,
      d.announcement_date AS "announcementDate",
      EXTRACT(YEAR FROM d.announcement_date)::int AS year,
      d.announcement_date::text AS "dateISO",
      d.close_date       AS "closingDate",
      d.is_private_equity AS "isPrivateEquity",
      d.is_hostile        AS "isHostile",
      d.ai_summary        AS "aiSummary",
      d.source_confidence AS confidence,
      d.extraction_method AS "extractionMethod",
      ds.source_type  AS "sourceType",
      ds.source_name  AS "sourceName",
      ds.source_url   AS "sourceUrl",
      ds.source_date  AS "sourceDate",
      f.filing_type   AS "filingType",
      f.document_url  AS "documentUrl",
      f.edgar_url     AS "edgarUrl",
      f.accession_no  AS "accessionNo",
      f.cik           AS "filingCik"
    FROM deals d
    LEFT JOIN companies a     ON d.acquirer_id = a.id
    LEFT JOIN companies t     ON d.target_id   = t.id
    LEFT JOIN LATERAL (
      SELECT source_type, source_name, source_url, source_date
      FROM deal_sources
      WHERE deal_id = d.id
      ORDER BY id
      LIMIT 1
    ) ds ON true
    LEFT JOIN LATERAL (
      SELECT filing_type, document_url, edgar_url, accession_no, cik
      FROM filings
      WHERE deal_id = d.id
      ORDER BY id
      LIMIT 1
    ) f ON true
    ORDER BY d.announcement_date DESC NULLS LAST
  `);

  const now = new Date();

  // Placeholder strings stored in the companies table when extraction failed
  const PLACEHOLDERS = new Set([
    'Acquirer (see filing)', 'Disclosed in filing',
    'Public company target (see filing)', 'Target (see filing)',
    'Unknown',
  ]);

  const deals = res.rows.map(row => {
    const acquirer = cleanCompanyName(row.acquirer, PLACEHOLDERS) || cleanCompanyName(row.extractedAcquirer, PLACEHOLDERS);
    const target   = cleanCompanyName(row.target,   PLACEHOLDERS) || cleanCompanyName(row.extractedTarget, PLACEHOLDERS);
    const dealType   = row.dealType || 'Merger';
    const headline   = !row.headline || /see filing|^(unknown|undisclosed)/i.test(row.headline)
      ? `${acquirer || 'Unknown acquirer'} / ${target || 'Unknown target'}`
      : row.headline;
    const dateObj    = row.announcementDate ? new Date(row.announcementDate) : null;
    const dateStr    = dateObj ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const year       = row.year || (dateObj ? dateObj.getFullYear() : null);
    const perShare   = row.perShare ? `$${Number(row.perShare).toFixed(2)}` : null;
    const premium    = row.premium  ? `${Math.round(Number(row.premium) * 100)}%` : null;
    const breaking   = !!(year === now.getFullYear() && row.status === 'Announced');
    const dealValNum = row.dealValueCents ? Number(row.dealValueCents) / 100 : 0;

    const source     = resolveSourceName(row);
    const timeAgo    = computeTimeAgo(dateObj, now);
    const era        = computeEra(year);
    const subheadline = buildSubheadline(row, acquirer, target, dateStr);
    const body       = row.aiSummary || buildBody(row, acquirer, target, dealType, dateStr, perShare);
    const summary    = buildSummary(row, acquirer, target, dealType, dateStr, row.dealValue, body);

    return {
      id:           row.id,
      headline,
      subheadline,
      acquirer,
      extractedAcquirer: row.extractedAcquirer || null,
      target,
      extractedTarget: row.extractedTarget || null,
      dealType,
      status:       row.status,
      dealValue:    row.dealValue,
      dealValueNum: dealValNum,
      perShare,
      premium,
      sector:       row.sector,
      region:       row.region,
      country:      row.country,
      date:         dateStr,
      year,
      dateISO:      row.dateISO,
      closingDate:  row.closingDate,
      timeAgo,
      era,
      isPrivateEquity: row.isPrivateEquity || false,
      isHostile:       row.isHostile        || false,
      body,
      summary,
      source,
      sourceUrl:    canonicalPrimarySourceUrl(row),
      filingType:   row.filingType,
      edgarUrl:     canonicalPrimarySourceUrl(row) || reconstructEdgarUrl(row) || row.edgarUrl,
      extractionMethod: row.extractionMethod,
      sourceType:   row.sourceType,
      sourceName:   row.sourceName,
      accessionNo:  row.accessionNo,
      confidence:   row.confidence,
      breaking,
      advisors:     null,
    };
  });

  // Deduplicate only when reliable source or transaction identity agrees.
  const deduped = deduplicateDeals(deals);
  console.log(`[EXPORT] Deduped ${deals.length} → ${deduped.length} records (removed ${deals.length - deduped.length} duplicates)`);

  console.log(`[EXPORT] Exporting ${deduped.length} deals...`);

  const json = JSON.stringify(deduped, null, 2);

  // LOCAL_ONLY=true: write to disk only (workflow commits via git)
  if (process.env.LOCAL_ONLY === 'true') {
    syncActionsCheckout();
    require('fs').writeFileSync('deals.json', json + '\n');
    console.log('[EXPORT] Wrote', deduped.length, 'deals to local deals.json');
    return;
  }

  const encoded = Buffer.from(json).toString('base64');
  const sha     = await getFileSHA();

  console.log('[EXPORT] Current SHA:', sha || 'new file');

  await pushToGitHub(encoded, sha);
  console.log('[EXPORT] Done! GitHub updated with', deduped.length, 'deals');
}

function syncActionsCheckout() {
  if (process.env.GITHUB_ACTIONS !== 'true') return;

  console.log('[EXPORT] Synchronizing Actions checkout with latest main');
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
  execFileSync('git', ['reset', '--hard', 'origin/main'], { stdio: 'inherit' });
}

/* ── Summary generation (ported from generate-summaries.py) ─────────── */

const TICKER_RE = /\s*\([A-Z]{1,5}\)/g;

function cleanName(name) {
  if (!name) return '';
  return name.replace(TICKER_RE, '').trim();
}

function buildSummary(row, acquirerRaw, targetRaw, dealType, date, dealValue, body) {
  const source = resolveSourceName(row);
  if (source !== 'SEC Filing' && body) { const first=body.split(/(?<=[a-z])\.\s+(?=[A-Z])/)[0].replace(/\.$/,''); if(first&&first.length>30)return first+'.'; }
  const acquirer=cleanName(acquirerRaw), target=cleanName(targetRaw); const val=dealValue&&dealValue!=='Undisclosed'?dealValue:null; const valStr=val?' valued at '+val:''; const form=String(row.filingType||'').toUpperCase();
  const parties=acquirer&&target?acquirer+' and '+target:(acquirer||target||'The transaction parties');
  if (form==='SC TO-T'||form==='SC TO-T/A') return parties+' are the subject of a tender offer statement filed with the SEC on '+date+valStr+'.';
  if (form==='DEFM14A') return parties+' are described in a definitive merger proxy statement filed with the SEC on '+date+valStr+'.';
  if (form==='PREM14A'||form==='DEFA14A') return parties+' are described in proxy materials filed with the SEC on '+date+valStr+'.';
  if (form==='S-4'||form==='S-4/A') return parties+' are described in an SEC registration statement concerning a proposed transaction filed on '+date+valStr+'.';
  if (form==='SC 13E-3'||form==='SC 13E-3/A') return parties+' are described in an SEC going-private transaction statement filed on '+date+valStr+'.';
  if (source==='SEC Filing') return parties+' are described in an SEC filing'+(form?' (Form '+form+')':'')+' filed on '+date+valStr+'.';
  if (acquirer&&target) return acquirer+' announced a '+String(dealType||'transaction').toLowerCase()+' involving '+target+valStr+(date?' on '+date:'')+'.';
  return (row.headline||'Transaction')+(date?' — '+date:'')+'.';
}

function buildBody(row, acquirer, target, dealType, date, perShare) {
  const val=row.dealValue&&row.dealValue!=='Undisclosed'?' at '+row.dealValue:''; const form=String(row.filingType||'').toUpperCase(); const source=resolveSourceName(row); const parties=[acquirer,target].filter(Boolean).join(' and ')||'The transaction';
  if(source==='SEC Filing') return parties+' is documented in '+(form?'Form '+form:'an SEC filing')+(date?' filed on '+date:'')+val+'. The source link points directly to the filing document.';
  if(source==='EU Merger Registry') return parties+' is documented in the European Commission merger-control source'+(date?' dated '+date:'')+'.';
  if(/HKEX|ASX|SGX/.test(source)) return parties+' is documented in a '+source+' company announcement'+(date?' dated '+date:'')+'.';
  return parties+' announced a '+String(dealType||'transaction').toLowerCase()+val+(date?' on '+date:'')+'.';
}

const SEC_FORM_DESC = {
  'DEFM14A':   'definitive merger proxy statement',
  'PREM14A':   'preliminary merger proxy statement',
  'SC TO-T':   'tender offer statement',
  'SC TO-T/A': 'amended tender offer statement',
  'S-4':       'registration statement for merger',
  'SC 13E-3':  'going-private transaction statement',
  'SC 13E-3/A':'amended going-private transaction statement',
  'DEFA14A':   'additional definitive proxy materials',
};

function buildSubheadline(row, acquirer, target, date) {
  const parts = [];
  const source = resolveSourceName(row);

  if (row.filingType) {
    parts.push(`${row.filingType} ${source === 'SEC Filing' ? 'filed with SEC' : 'filing'}`);
  } else if (source && source !== 'SEC Filing') {
    parts.push(`via ${source}`);
  }

  if (row.perShare) {
    parts.push(`$${Number(row.perShare).toFixed(2)} per share`);
  }

  if (row.dealValue && row.dealValue !== 'Undisclosed') {
    if (!row.perShare) parts.push(row.dealValue);
  }

  if (date) parts.push(date);

  if (parts.length === 0) {
    if (acquirer && target && acquirer !== 'Undisclosed' && target !== 'Undisclosed')
      return `${acquirer} / ${target} — ${date || ''}`.trim();
    return date || '';
  }

  return parts.join(' — ');
}

function cleanCompanyName(name, placeholders) {
  if (!name || placeholders.has(name)) return 'Undisclosed';
  if (/^(?:BCP Investment Corp|EDGARFILINGS LTD|Toppan Merrill\/FA|.*(?:Filing Services|Filing Agent)|Donnelley Financial.*)$/i.test(String(name).trim())) return 'Undisclosed';
  // Strip EDGAR annotations: "(CEPO)", "(CIK 0002027708)", extra whitespace
  return name
    .replace(/\s*\([A-Z]{1,5}\)\s*/g, ' ')        // ticker symbols
    .replace(/\s*\(CIK\s+\d+\)\s*/gi, ' ')         // CIK annotations
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Undisclosed';
}

function reconstructEdgarUrl(row) {
  const direct = firstDirectSecArchiveUrl(row.documentUrl, row.edgarUrl, row.sourceUrl);
  if (direct) return direct;

  const rawAcc = String(row.accessionNo || '');
  const accPart = rawAcc.split(':')[0];
  const accession = accPart.match(/^(\d{10})-(\d{2})-(\d{6})/);
  const cik = String(row.filingCik || '').replace(/\D/g, '').replace(/^0+/, '');

  if (accession && cik) {
    const folder = `${accession[1]}${accession[2]}${accession[3]}`;
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${accession[1]}-${accession[2]}-${accession[3]}-index.html`;
  }

  return null;
}

function firstDirectSecArchiveUrl(...urls) {
  for (const url of urls) {
    const value = String(url || '').trim();
    if (/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[^?#\s]+/i.test(value)) {
      return value;
    }
  }
  return null;
}

function resolveSourceName(row) {
  const method = row.extractionMethod || '';
  const type   = row.sourceType       || '';
  const name   = row.sourceName       || '';

  if (method === 'sec_filing'   || type === 'sec_edgar')           return 'SEC Filing';
  if (method === 'eu_merger_registry' || type === 'eu_merger_registry') return 'EU Merger Registry';
  if (method === 'news_rss'     || type === 'news_rss') {
    if (name) return name;
    return 'News RSS';
  }
  if (method === 'hkex'  || /hkex/i.test(name))   return 'HKEX';
  if (method === 'asx'   || /\basx\b/i.test(name)) return 'ASX';
  if (method === 'sgx'   || /\bsgx\b/i.test(name)) return 'SGX';
  if (name) return name;
  return 'SEC Filing';
}

function computeTimeAgo(dateObj, now) {
  if (!dateObj || isNaN(dateObj)) return null;
  const diffMs   = now - dateObj;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0)  return 'Today';
  if (diffDays === 1)  return 'Yesterday';
  if (diffDays < 7)   return `${diffDays} days ago`;
  if (diffDays < 30)  return `${Math.floor(diffDays / 7)} week${diffDays < 14 ? '' : 's'} ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${diffDays < 60 ? '' : 's'} ago`;
  const yrs = Math.floor(diffDays / 365);
  return `${yrs} year${yrs === 1 ? '' : 's'} ago`;
}

function computeEra(year) {
  if (!year) return null;
  const decade = Math.floor(year / 10) * 10;
  return `${decade}s`;
}

/* ── GitHub helpers ─────────────────────────────────────────────────── */

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

module.exports = { run, deduplicateDeals, identityKeys, isSpecificSourceUrl, isPublishableDeal, reconstructEdgarUrl };

if (require.main === module) {
  run().then(() => db.end()).catch(err => {
    console.error('[EXPORT] Fatal:', err.message);
    db.end();
    process.exit(1);
  });
}
