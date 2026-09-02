'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const sourceUrlPath = fs.existsSync(path.join(__dirname, '../services/shared/source-url.js'))
  ? '../services/shared/source-url'
  : './FIX-source-url';
const { canonicalPrimarySourceUrl } = require(sourceUrlPath);

const RULE_VERSION = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const LIMIT = Math.max(1, Math.min(100000, Number(process.env.TRANSACTION_REVIEW_LIMIT || 30000)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TRANSACTION_REVIEW_CONCURRENCY || 4)));
const WAIT_MS = Math.max(0, Number(process.env.TRANSACTION_REVIEW_POLITENESS_MS || 250));
const MAX_BYTES = 500000;
const TIMEOUT_MS = 15000;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: CONCURRENCY + 2,
  statement_timeout: 120000,
});

const PLACEHOLDER = /^(?:unknown|undisclosed|n\/?a|null|none|tbd|not disclosed|see filing|disclosed in filing|acquirer \(see filing\)|target \(see filing\)|public company target \(see filing\)|no)$/i;
const GENERIC = /^(?:merger sub(?:sidiary)?|acquisition sub(?:sidiary)?|purchaser|parent|buyer|seller|issuer|offeror|bidder|investor|management team|shareholders?)$/i;
const FILING_AGENT = /\b(?:BCP Investment Corp|Merrill Corp|Toppan Merrill|Donnelley Financial|EDGARfilings|filing services|filing agent)\b/i;
const BAD_PARTY = /\b(?:shares?|stake|equity interest|agreement|announces?|entered|signing|definitive|majority stake|minority stake|all outstanding|common stock|ordinary stock|shareholders?|new campus|portfolio of properties|to power|to expand|to create|bringing|creating|expanding|accelerating|transforming|strengthening)\b/i;

const MERGER = /\b(?:agreement and plan of merger|merger agreement|business combination agreement|definitive merger agreement|proposed merger|merger with|merge with|business combination with|scheme of arrangement)\b/i;
const ACQUISITION = /\b(?:definitive agreement to acquire|agreed to acquire|agrees to acquire|to be acquired by|agreed to be acquired by|acquisition of|acquire all(?: of)? the outstanding|purchase all(?: of)? the outstanding|acquire 100%|acquire a controlling interest|acquire a majority interest)\b/i;
const TENDER = /\b(?:tender offer to purchase all|offer to purchase all(?: of)? the outstanding|any and all outstanding shares|all outstanding shares pursuant to the tender offer|tender offer for all outstanding)\b/i;
const GOING_PRIVATE = /\b(?:going[- ]private transaction|take[- ]private|taken private|leveraged buyout|management buyout|cash-out merger)\b/i;
const DIVESTITURE = /\b(?:sale of (?:the )?(?:business|division|subsidiary|operations)|sell(?:ing)? (?:its|the) (?:business|division|subsidiary|operations)|acquire(?:s|d|ing)? (?:the )?(?:business|division|subsidiary|operations) of)\b/i;
const CONTROL = new RegExp([MERGER.source, ACQUISITION.source, TENDER.source, GOING_PRIVATE.source, DIVESTITURE.source].join('|'), 'i');

const NON_MNA = /\b(?:director(?:s)?|officer(?:s)?|insider(?:s)?|employee(?:s)?|executive(?:s)?|beneficial owner(?:ship)?|form 4|schedule 13[gd]|open[- ]market purchase|stock option|share option|restricted stock|rsu|equity award|vesting|exercise(?:d)? options?|share buyback|stock buyback|repurchase|treasury shares?|dividend|funding round|series [a-z]|venture funding|debt financing|credit facility|bond issuance|strategic investment|minority investment|minority stake|non-controlling stake|partnership|joint venture|licen[cs](?:e|ing)|distribution agreement|collaboration|supply agreement|initial public offering|ipo priced|earnings|quarterly results|annual results|letter of intent|memorandum of understanding|non-binding proposal|proposal to acquire|exploring (?:a )?(?:sale|acquisition)|considering (?:a )?(?:sale|acquisition)|mini-tender)\b/i;
const SHARE_PURCHASE = /\b(?:acquir\w*|purchas\w*|buy\w*)\b.{0,90}\b(?:additional\s+)?\d[\d.,]*\s*(?:million|billion|m|bn)?\s*(?:ordinary\s+|common\s+)?shares?\b|\b(?:increases?|raises?) (?:its )?stake\b|\b(?:shares?|stake|equity interest)\s+(?:in|of)\b/i;
const CONTROL_STAKE = /\b(?:all(?: of)? the outstanding|all outstanding|100%|majority interest|controlling interest|control of|tender offer to purchase all|going[- ]private|take[- ]private)\b/i;
const PARTIAL_TENDER = /\b(?:mini-tender|offer to purchase up to \d[\d,]*(?:\.\d+)?\s*(?:million|billion)?\s*(?:common|ordinary)?\s*shares?)\b/i;

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .toLowerCase()
    .replace(/\([^)]*(?:cik|ticker|nasdaq|nyse|asx|hkex|sgx)[^)]*\)/gi, ' ')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeName(value).split(' ').filter(token => token.length >= 3);
}

function isReliableParty(value) {
  const raw = String(value || '').replace(/&amp;/gi, '&').trim();
  const nameTokens = tokens(raw);
  return !!(
    raw && raw.length <= 120 &&
    !PLACEHOLDER.test(raw) && !GENERIC.test(raw) && !FILING_AGENT.test(raw) && !BAD_PARTY.test(raw) &&
    !/^unknown|^undisclosed|see filing/i.test(raw) &&
    nameTokens.length && nameTokens.length <= 12 && /[A-Za-z]{2}/.test(raw)
  );
}

function distinctParties(acquirer, target) {
  return isReliableParty(acquirer) && isReliableParty(target) && normalizeName(acquirer) !== normalizeName(target);
}

function nameAppears(name, source) {
  const haystack = ` ${String(source || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const nameTokens = tokens(name);
  if (!nameTokens.length) return false;
  const hits = nameTokens.filter(token => haystack.includes(` ${token} `)).length;
  return hits >= (nameTokens.length === 1 ? 1 : Math.max(2, Math.ceil(nameTokens.length * 0.75)));
}

function classifyTransaction(source, filingType, headline) {
  const evidence = `${headline || ''}\n${source || ''}`;
  const form = String(filingType || '').toUpperCase();
  if (form.startsWith('SC 13E-3') || GOING_PRIVATE.test(evidence)) return 'LBO / Going-Private';
  if (form.startsWith('SC TO-T') || TENDER.test(evidence)) return 'Tender Offer';
  if (MERGER.test(evidence)) return 'Merger / Business Combination';
  if (DIVESTITURE.test(evidence)) return 'Divestiture / Carve-Out';
  if (ACQUISITION.test(evidence)) return 'Acquisition';
  return null;
}

function reviewResult(status, reasonCode, extra = {}) {
  return { status, reasonCode, transactionType: null, evidenceExcerpt: null, ...extra };
}

function reviewEvidence(record, source) {
  if (!distinctParties(record.acquirer, record.target)) return reviewResult('rejected', 'unresolved_or_invalid_parties');

  const primary = stripHtml(source);
  const raw = String(record.rawExtractedSnippet || record.sourceRawContent || '');
  const partyEvidence = `${raw}\n${primary}`;
  const shortEvidence = `${record.headline || ''}\n${raw}`;
  const form = String(record.filingType || '').toUpperCase();
  const sourceType = String(record.sourceType || record.extractionMethod || '').toLowerCase();

  if (!nameAppears(record.acquirer, partyEvidence) || !nameAppears(record.target, partyEvidence)) {
    return reviewResult('rejected', 'party_not_confirmed_in_primary_source');
  }
  if (NON_MNA.test(shortEvidence) && !CONTROL.test(shortEvidence)) return reviewResult('rejected', 'non_mna_context');
  if (SHARE_PURCHASE.test(shortEvidence) && !CONTROL_STAKE.test(shortEvidence) && !CONTROL.test(shortEvidence)) return reviewResult('rejected', 'non_control_share_purchase');

  if (sourceType.includes('sec') || form) {
    if (form.startsWith('SC TO-T')) {
      if (PARTIAL_TENDER.test(primary) && !TENDER.test(primary)) return reviewResult('rejected', 'partial_tender_not_control_transaction');
      if (!TENDER.test(primary) && !MERGER.test(primary)) return reviewResult('needs_review', 'tender_control_not_proven');
    } else if (form.startsWith('SC 13E-3')) {
      if (!GOING_PRIVATE.test(primary) && !MERGER.test(primary)) return reviewResult('needs_review', 'going_private_not_proven');
    } else if (['DEFM14A', 'PREM14A'].includes(form)) {
      if (!CONTROL.test(primary)) return reviewResult('needs_review', 'control_transaction_not_proven');
    } else if (['DEFA14A', 'S-4', 'S-4/A'].includes(form)) {
      if (!CONTROL.test(primary)) return reviewResult('rejected', 'conditional_filing_without_mna_evidence');
    } else {
      return reviewResult('needs_review', 'unsupported_sec_form');
    }
  } else if (sourceType === 'eu_merger_registry') {
    if (/\bjoint venture\b/i.test(shortEvidence)) return reviewResult('rejected', 'joint_venture_not_mna');
    if (!CONTROL.test(`${shortEvidence}\n${primary}`)) return reviewResult('needs_review', 'eu_control_transaction_not_proven');
  } else {
    if (!CONTROL.test(`${shortEvidence}\n${primary}`)) return reviewResult('rejected', 'no_explicit_control_transaction_evidence');
    if (PARTIAL_TENDER.test(shortEvidence) && !TENDER.test(shortEvidence)) return reviewResult('rejected', 'partial_tender_not_control_transaction');
    if (SHARE_PURCHASE.test(shortEvidence) && !CONTROL_STAKE.test(shortEvidence)) return reviewResult('rejected', 'non_control_share_purchase');
  }

  const transactionType = classifyTransaction(primary || raw, form, record.headline);
  if (!transactionType) return reviewResult('needs_review', 'transaction_type_not_proven');

  const match = GOING_PRIVATE.exec(primary) || TENDER.exec(primary) || MERGER.exec(primary) || ACQUISITION.exec(primary) || DIVESTITURE.exec(primary);
  const excerpt = match
    ? primary.slice(Math.max(0, match.index - 160), Math.min(primary.length, match.index + 500))
    : primary.slice(0, 700);
  return reviewResult('verified', 'verified_primary_source_control_transaction', {
    transactionType,
    evidenceExcerpt: excerpt.slice(0, 700),
  });
}

function fetchText(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'mergers.news transaction verifier contact@mergers.news',
        Accept: 'text/html,text/plain,application/xhtml+xml,*/*',
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return fetchText(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        if (size >= MAX_BYTES) return;
        const remaining = MAX_BYTES - size;
        const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        size += piece.length;
        chunks.push(piece);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS deal_transaction_reviews(
      deal_id UUID PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL,
      transaction_type VARCHAR(80),
      reason_code VARCHAR(120) NOT NULL,
      rule_version VARCHAR(40) NOT NULL,
      evidence_url TEXT,
      evidence_excerpt TEXT,
      evidence_hash VARCHAR(64),
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detail JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_deal_transaction_reviews_status
      ON deal_transaction_reviews(status,rule_version,reviewed_at DESC);
  `);
}

async function candidates() {
  const result = await db.query(`
    SELECT d.id,d.headline,d.deal_type AS "dealType",d.source_confidence AS confidence,
           d.extraction_method AS "extractionMethod",d.raw_extracted_snippet AS "rawExtractedSnippet",
           d.needs_review AS "needsReview",a.name AS acquirer,t.name AS target,
           ds.source_type AS "sourceType",ds.source_name AS "sourceName",ds.source_url AS "sourceUrl",
           ds.raw_content AS "sourceRawContent",f.filing_type AS "filingType",
           f.document_url AS "documentUrl",f.edgar_url AS "edgarUrl",f.accession_no AS "accessionNo",f.cik AS "filingCik"
    FROM deals d
    LEFT JOIN companies a ON a.id=d.acquirer_id
    LEFT JOIN companies t ON t.id=d.target_id
    LEFT JOIN LATERAL(
      SELECT source_type,source_name,source_url,raw_content
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
    LEFT JOIN LATERAL(
      SELECT filing_type,document_url,edgar_url,accession_no,cik
      FROM filings
      WHERE deal_id=d.id
      ORDER BY filing_date DESC NULLS LAST,created_at DESC,id
      LIMIT 1
    ) f ON true
    LEFT JOIN deal_transaction_reviews review ON review.deal_id=d.id
    WHERE d.canonical_id IS NULL
      AND d.acquirer_id IS NOT NULL AND d.target_id IS NOT NULL AND d.acquirer_id<>d.target_id
      AND (
        review.deal_id IS NULL OR review.rule_version<>$1 OR d.updated_at>review.reviewed_at OR
        (review.status='needs_review' AND review.reviewed_at<NOW()-INTERVAL '24 hours')
      )
    ORDER BY d.needs_review DESC,d.source_confidence DESC NULLS LAST,
             d.announcement_date DESC NULLS LAST,d.created_at DESC,d.id
    LIMIT $2
  `, [RULE_VERSION, LIMIT]);
  return result.rows;
}

async function saveReview(record, review, evidenceUrl) {
  const hash = review.evidenceExcerpt ? crypto.createHash('sha256').update(review.evidenceExcerpt).digest('hex') : null;
  await db.query(`
    INSERT INTO deal_transaction_reviews(
      deal_id,status,transaction_type,reason_code,rule_version,evidence_url,evidence_excerpt,evidence_hash,reviewed_at,detail
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9::jsonb)
    ON CONFLICT(deal_id) DO UPDATE SET
      status=EXCLUDED.status,transaction_type=EXCLUDED.transaction_type,reason_code=EXCLUDED.reason_code,
      rule_version=EXCLUDED.rule_version,evidence_url=EXCLUDED.evidence_url,evidence_excerpt=EXCLUDED.evidence_excerpt,
      evidence_hash=EXCLUDED.evidence_hash,reviewed_at=NOW(),detail=EXCLUDED.detail
  `, [
    record.id,review.status,review.transactionType,review.reasonCode,RULE_VERSION,evidenceUrl || null,
    review.evidenceExcerpt || null,hash,
    JSON.stringify({ filingType: record.filingType || null, sourceType: record.sourceType || null, sourceName: record.sourceName || null }),
  ]);
}

async function reviewOne(record) {
  if (!distinctParties(record.acquirer, record.target)) {
    const review = reviewResult('rejected', 'unresolved_or_invalid_parties');
    await saveReview(record, review, null);
    return review;
  }

  const evidenceUrl = canonicalPrimarySourceUrl(record);
  if (!evidenceUrl) {
    const review = reviewResult('needs_review', 'missing_primary_source');
    await saveReview(record, review, null);
    return review;
  }

  let source = record.sourceRawContent || '';
  try {
    source = await fetchText(evidenceUrl);
    if (WAIT_MS) await new Promise(resolve => setTimeout(resolve, WAIT_MS));
  } catch (error) {
    if (!source && !record.rawExtractedSnippet) {
      const review = reviewResult('needs_review', 'primary_source_unreachable');
      await saveReview(record, review, evidenceUrl);
      return review;
    }
  }

  const review = reviewEvidence(record, source || record.rawExtractedSnippet || '');
  await saveReview(record, review, evidenceUrl);
  return review;
}

async function run() {
  await ensureSchema();
  const queue = await candidates();
  const counts = { verified: 0, rejected: 0, needs_review: 0, errors: 0 };
  console.log('[REVIEW] queued', queue.length);
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const record = queue[cursor++];
      try {
        const review = await reviewOne(record);
        counts[review.status] = (counts[review.status] || 0) + 1;
      } catch (error) {
        counts.errors++;
        console.error('[REVIEW]', record.id, error.stack || error.message);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const summary = await db.query(`
    SELECT status,reason_code,transaction_type,COUNT(*)::int AS count
    FROM deal_transaction_reviews
    WHERE rule_version=$1
    GROUP BY 1,2,3
    ORDER BY count DESC,status,reason_code
  `, [RULE_VERSION]);

  const invariant = await db.query(`
    SELECT COUNT(*)::int AS invalid
    FROM deal_transaction_reviews review
    JOIN deals d ON d.id=review.deal_id
    WHERE review.rule_version=$1 AND review.status='verified'
      AND (d.canonical_id IS NOT NULL OR d.acquirer_id IS NULL OR d.target_id IS NULL OR d.acquirer_id=d.target_id OR NULLIF(TRIM(review.evidence_url),'') IS NULL)
  `, [RULE_VERSION]);
  if (Number(invariant.rows[0].invalid) > 0) throw new Error(`Transaction-review invariant breach: ${invariant.rows[0].invalid} invalid verified row(s)`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    ruleVersion: RULE_VERSION,
    processedThisRun: counts,
    reviewSummary: summary.rows,
    publicationRule: 'Verified primary-source control transactions only.',
  };
  fs.writeFileSync('deal-review-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[REVIEW] complete', JSON.stringify(counts));

  const errorBudget = Math.max(3, Math.ceil(queue.length * 0.005));
  if (counts.errors > errorBudget) throw new Error(`Transaction review exceeded error budget: ${counts.errors}/${queue.length}`);
  return manifest;
}

async function close() {
  await db.end();
}

module.exports = {
  RULE_VERSION,run,close,normalizeName,nameAppears,isReliableParty,distinctParties,
  classifyTransaction,reviewEvidence,stripHtml,reviewOne,
};

if (require.main === module) {
  run()
    .then(() => close())
    .catch(async error => {
      console.error(error.stack || error);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}
