'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const RULE_VERSION = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const ENGINE_VERSION = 'legacy-control-review-v1.0';
const DEALS_FILE = process.env.LEGACY_REVIEW_DEALS_FILE || 'deals.json';
const STATE_FILE = process.env.LEGACY_REVIEW_STATE_FILE || 'legacy-review-state.json';
const MANIFEST_FILE = process.env.LEGACY_REVIEW_MANIFEST_FILE || 'legacy-review-manifest.json';
const BATCH_SIZE = Math.max(1, Math.min(2000, Number(process.env.LEGACY_REVIEW_BATCH_SIZE || 500)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.LEGACY_REVIEW_CONCURRENCY || 4)));
const POLITENESS_MS = Math.max(0, Math.min(3000, Number(process.env.LEGACY_REVIEW_POLITENESS_MS || 250)));
const MAX_BYTES = Math.max(250000, Math.min(4 * 1024 * 1024, Number(process.env.LEGACY_REVIEW_MAX_BYTES || 1500000)));
const TIMEOUT_MS = Math.max(5000, Math.min(45000, Number(process.env.LEGACY_REVIEW_TIMEOUT_MS || 15000)));
const MAX_ATTEMPTS = Math.max(1, Math.min(8, Number(process.env.LEGACY_REVIEW_MAX_ATTEMPTS || 3)));
const RETRY_HOURS = Math.max(1, Math.min(168, Number(process.env.LEGACY_REVIEW_RETRY_HOURS || 12)));
const MIN_VERIFIED = Math.max(1000, Number(process.env.LEGACY_REVIEW_MIN_VERIFIED || 10000));
const MIN_VERIFIED_RATIO = Math.max(0.1, Math.min(0.95, Number(process.env.LEGACY_REVIEW_MIN_VERIFIED_RATIO || 0.45)));
const MAX_UNRESOLVED_RATIO = Math.max(0, Math.min(0.8, Number(process.env.LEGACY_REVIEW_MAX_UNRESOLVED_RATIO || 0.20)));
const MAX_REJECTED_RATIO = Math.max(0, Math.min(0.8, Number(process.env.LEGACY_REVIEW_MAX_REJECTED_RATIO || 0.45)));
const AUTO_CUTOVER = String(process.env.LEGACY_REVIEW_AUTO_CUTOVER || 'false').toLowerCase() === 'true';
const USER_AGENT = 'mergers.news historical transaction verifier contact@mergers.news';

// The shared verifier exposes pure review functions but creates a pg Pool when
// loaded. Historical file review never connects to it; this inert URL prevents a
// missing DATABASE_URL from blocking pure-function reuse.
process.env.DATABASE_URL ||= 'postgres://legacy_review:legacy_review@127.0.0.1:9/legacy_review';
const review = require('./FIX-transaction-review');
const extraction = require('./FIX-deal-extraction');
const { canonicalPrimarySourceUrl } = require('./FIX-source-url');
const { isPublicTransaction } = require('./build-public-artifacts');

const EXPLICIT_NON_CONTROL = /\b(?:minority|non[- ]controlling)\s+(?:investment|stake|interest|position)|strategic\s+minority\s+investment\b/i;
const JOINT_VENTURE = /\bjoint\s+venture\b/i;
const NON_BINDING = /\b(?:non[- ]binding|letter of intent|memorandum of understanding|proposal to acquire|exploring (?:a )?(?:sale|acquisition)|considering (?:a )?(?:sale|acquisition))\b/i;
const CONTROL_OVERRIDE = /\b(?:all(?: of)? the outstanding|all outstanding|100\s*%|majority (?:stake|interest|ownership)|controlling (?:stake|interest)|control of|all remaining|remaining (?:shares|stake|interest|equity)|tender offer (?:to purchase|for) all|going[- ]private|take[- ]private|agreement and plan of merger|merger agreement|business combination agreement|scheme of arrangement)\b/i;
const TRANSACTION_TERM = /\b(?:acquir(?:e|es|ed|ing|er|ition)|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|stake|interest|merger|merge|tender offer|going[- ]private|take[- ]private|business combination|divestiture|sale of)\b/gi;
const STAKE_PERCENT = /(?:acquir\w*|purchas\w*|buy\w*)[^.!?]{0,140}?([0-9]{1,3}(?:\.[0-9]+)?)\s*%[^.!?]{0,80}?(?:stake|interest|shares?|equity)|([0-9]{1,3}(?:\.[0-9]+)?)\s*%[^.!?]{0,80}?(?:stake|interest|shares?|equity)[^.!?]{0,140}?(?:acquir\w*|purchas\w*|buy\w*)/gi;
const STRONG_CONTROL_TYPES = new Set(['Merger / Business Combination', 'Tender Offer', 'LBO / Going-Private']);
const UNCERTAIN_BASE_REASONS = new Set([
  'unresolved_or_invalid_parties',
  'party_not_confirmed_in_primary_source',
  'tender_control_not_proven',
  'going_private_not_proven',
  'control_transaction_not_proven',
  'conditional_filing_without_mna_evidence',
  'unsupported_sec_form',
  'eu_control_transaction_not_proven',
  'no_explicit_control_transaction_evidence',
  'transaction_type_not_proven',
]);
const RETRYABLE_REASONS = new Set(['primary_source_unreachable', 'source_request_error']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transactionWindows(source, maxWindows = 12) {
  const text = String(source || '').replace(/\s+/g, ' ');
  const windows = [];
  TRANSACTION_TERM.lastIndex = 0;
  let match;
  while ((match = TRANSACTION_TERM.exec(text)) !== null && windows.length < maxWindows) {
    windows.push(text.slice(Math.max(0, match.index - 220), Math.min(text.length, match.index + 420)));
  }
  return windows.join('\n');
}

function stakePercentages(text) {
  const values = [];
  STAKE_PERCENT.lastIndex = 0;
  let match;
  while ((match = STAKE_PERCENT.exec(String(text || ''))) !== null && values.length < 12) {
    const value = Number(match[1] || match[2]);
    if (Number.isFinite(value) && value > 0 && value <= 100) values.push(value);
  }
  return values;
}

/**
 * Second, independent false-positive guard for historical migration.
 * The base verifier proves parties + an M&A control phrase. This guard prevents
 * generic words such as "acquisition" from promoting minority/non-control stake
 * purchases, joint ventures, or non-binding proposals.
 */
function enforceHistoricalControlGuard(record, source, result) {
  if (!result || result.status !== 'verified') return result;
  const window = transactionWindows(`${record.headline || ''}\n${source || ''}`);
  const strongType = STRONG_CONTROL_TYPES.has(result.transactionType);
  const controlOverride = CONTROL_OVERRIDE.test(window);

  if (!strongType && EXPLICIT_NON_CONTROL.test(window) && !controlOverride) {
    return { status: 'rejected', reasonCode: 'legacy_explicit_non_control_transaction', transactionType: null, evidenceExcerpt: null };
  }
  if (!strongType && JOINT_VENTURE.test(window) && !controlOverride) {
    return { status: 'rejected', reasonCode: 'legacy_joint_venture_not_mna', transactionType: null, evidenceExcerpt: null };
  }
  if (!strongType && NON_BINDING.test(window) && !controlOverride) {
    return { status: 'rejected', reasonCode: 'legacy_non_binding_transaction', transactionType: null, evidenceExcerpt: null };
  }

  const percentages = stakePercentages(window);
  if (!strongType && percentages.some(value => value <= 50) && !controlOverride) {
    return { status: 'rejected', reasonCode: 'legacy_non_control_percentage_stake', transactionType: null, evidenceExcerpt: null };
  }
  return result;
}

function requestPrefix(url, maxBytes = MAX_BYTES, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,application/xhtml+xml,*/*' },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestPrefix(new URL(response.headers.location, url).toString(), maxBytes, redirects + 1).then(finish, fail);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (type.includes('application/pdf')) {
        response.resume();
        finish({ text: '', truncated: false, unsupportedType: 'application/pdf' });
        return;
      }
      const chunks = [];
      let captured = 0;
      response.on('data', chunk => {
        if (settled) return;
        const remaining = maxBytes - captured;
        if (remaining <= 0) return;
        const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(piece);
        captured += piece.length;
        if (captured >= maxBytes) {
          finish({ text: Buffer.concat(chunks).toString('utf8'), truncated: true, unsupportedType: null });
          response.destroy();
        }
      });
      response.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8'), truncated: false, unsupportedType: null }));
      response.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

function normalizeSourceType(deal) {
  const current = String(deal.sourceType || deal.extractionMethod || '').toLowerCase();
  if (current) return current;
  const url = String(deal.sourceUrl || deal.edgarUrl || '');
  if (/sec\.gov/i.test(url)) return 'sec_edgar';
  return 'historical_source';
}

function reviewRecord(deal) {
  return {
    headline: deal.headline || `${deal.acquirer || ''} / ${deal.target || ''}`,
    acquirer: deal.acquirer,
    target: deal.target,
    filingType: deal.filingType,
    sourceType: normalizeSourceType(deal),
    extractionMethod: deal.extractionMethod,
    rawExtractedSnippet: deal.rawExtractedSnippet || '',
    sourceRawContent: '',
  };
}

function repairParties(record, source) {
  const parsed = extraction.extractDeal(source, {
    filingType: record.filingType,
    sourceReliability: normalizeSourceType(record).includes('sec') ? 20 : 15,
    dedupCertainty: 0,
  });
  if (parsed.disposition !== 'candidate' || Number(parsed.confidence) < 0.82) return null;
  if (!review.distinctParties(parsed.acquirer, parsed.target)) return null;
  return {
    record: { ...record, acquirer: parsed.acquirer, target: parsed.target, rawExtractedSnippet: parsed.evidenceSnippet || '' },
    parsed,
  };
}

function evidenceHash(result) {
  return result?.evidenceExcerpt
    ? crypto.createHash('sha256').update(result.evidenceExcerpt).digest('hex')
    : null;
}

function recordKey(deal) {
  if (deal?.id !== undefined && deal?.id !== null && String(deal.id).trim()) return `id:${String(deal.id).trim()}`;
  const seed = [deal?.sourceUrl, deal?.edgarUrl, deal?.accessionNo, deal?.acquirer, deal?.target, deal?.dateISO, deal?.headline].join('|');
  return `hash:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function loadState(file = STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.ruleVersion !== RULE_VERSION || parsed.engineVersion !== ENGINE_VERSION || !parsed.records) {
      return { version: 1, ruleVersion: RULE_VERSION, engineVersion: ENGINE_VERSION, records: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[LEGACY REVIEW] resetting invalid state:', error.message);
    return { version: 1, ruleVersion: RULE_VERSION, engineVersion: ENGINE_VERSION, records: {} };
  }
}

function shouldAttempt(entry, now = Date.now()) {
  if (!entry) return true;
  if (entry.ruleVersion !== RULE_VERSION || entry.engineVersion !== ENGINE_VERSION) return true;
  if (entry.status === 'verified' || entry.status === 'rejected') return false;
  if (!RETRYABLE_REASONS.has(entry.reasonCode)) return false;
  if (Number(entry.attempts || 0) >= MAX_ATTEMPTS) return false;
  const last = Date.parse(entry.reviewedAt || '');
  return !Number.isFinite(last) || now - last >= RETRY_HOURS * 3600000;
}

function normalizeUncertain(result, truncated) {
  if (!result) return { status: 'needs_review', reasonCode: 'review_result_missing', transactionType: null, evidenceExcerpt: null };
  if (String(result.reasonCode || '').startsWith('legacy_')) return result;
  if (result.status === 'rejected' && (UNCERTAIN_BASE_REASONS.has(result.reasonCode) || truncated)) {
    return { ...result, status: 'needs_review', reasonCode: truncated ? 'source_truncated_before_verification' : result.reasonCode };
  }
  if (result.status === 'needs_review' && truncated) return { ...result, reasonCode: 'source_truncated_before_verification' };
  return result;
}

async function reviewOne(deal, previous = null) {
  const started = new Date().toISOString();
  const attempts = Number(previous?.attempts || 0) + 1;
  const record = reviewRecord(deal);
  const evidenceUrl = canonicalPrimarySourceUrl({ ...deal, sourceType: record.sourceType });
  const base = {
    ruleVersion: RULE_VERSION,
    engineVersion: ENGINE_VERSION,
    attempts,
    reviewedAt: started,
    evidenceUrl: evidenceUrl || null,
  };

  if (!evidenceUrl) return { ...base, status: 'needs_review', reasonCode: 'missing_primary_source', transactionType: null, evidenceHash: null };

  let fetched;
  try {
    fetched = await requestPrefix(evidenceUrl);
  } catch (error) {
    return { ...base, status: 'needs_review', reasonCode: 'primary_source_unreachable', transactionType: null, evidenceHash: null, error: String(error.message || error).slice(0, 240) };
  }
  if (fetched.unsupportedType) {
    return { ...base, status: 'needs_review', reasonCode: 'unsupported_source_content_type', transactionType: null, evidenceHash: null };
  }
  const source = stripHtml(fetched.text);
  if (source.length < 100) return { ...base, status: 'needs_review', reasonCode: 'primary_source_text_unavailable', transactionType: null, evidenceHash: null };

  let effectiveRecord = record;
  let repaired = false;
  let result = review.reviewEvidence(effectiveRecord, source);
  if (['unresolved_or_invalid_parties', 'party_not_confirmed_in_primary_source'].includes(result.reasonCode)) {
    const repair = repairParties(record, source);
    if (repair) {
      effectiveRecord = repair.record;
      result = review.reviewEvidence(effectiveRecord, source);
      repaired = result.status === 'verified';
    }
  }
  result = enforceHistoricalControlGuard(effectiveRecord, source, result);
  result = normalizeUncertain(result, fetched.truncated);

  return {
    ...base,
    status: result.status,
    reasonCode: result.reasonCode,
    transactionType: result.transactionType || null,
    evidenceHash: evidenceHash(result),
    repairedParties: repaired ? { acquirer: effectiveRecord.acquirer, target: effectiveRecord.target } : null,
    truncated: !!fetched.truncated,
  };
}

function duplicateIdCount(deals) {
  const seen = new Set();
  const dupes = new Set();
  for (const deal of deals) {
    if (deal?.id === undefined || deal?.id === null || !String(deal.id).trim()) continue;
    const id = String(deal.id);
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return dupes.size;
}

function summarize(deals, state) {
  const current = deals.map(deal => state.records[recordKey(deal)]).filter(Boolean)
    .filter(entry => entry.ruleVersion === RULE_VERSION && entry.engineVersion === ENGINE_VERSION);
  const counts = { verified: 0, rejected: 0, needs_review: 0, error: 0 };
  const reasons = {};
  for (const entry of current) {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
    reasons[entry.reasonCode] = (reasons[entry.reasonCode] || 0) + 1;
  }
  const total = deals.length;
  const reviewed = current.length;
  const unresolved = (counts.needs_review || 0) + (counts.error || 0);
  const verifiedRatio = total ? counts.verified / total : 0;
  const unresolvedRatio = total ? unresolved / total : 1;
  const rejectedRatio = total ? counts.rejected / total : 0;
  const duplicateIds = duplicateIdCount(deals);
  const complete = reviewed === total && total > 0;
  const cutoverEligible = complete && duplicateIds === 0 && counts.verified >= MIN_VERIFIED &&
    verifiedRatio >= MIN_VERIFIED_RATIO && unresolvedRatio <= MAX_UNRESOLVED_RATIO && rejectedRatio <= MAX_REJECTED_RATIO;
  return {
    total, reviewed, coveragePct: total ? Math.round(reviewed / total * 10000) / 100 : 0,
    counts, reasons, verifiedRatio, unresolvedRatio, rejectedRatio, duplicateIds, complete, cutoverEligible,
  };
}

function applyCutover(deals, state) {
  const output = deals.map(deal => {
    const entry = state.records[recordKey(deal)];
    if (!entry) throw new Error(`Missing review state for ${recordKey(deal)}`);
    const repaired = entry.repairedParties || {};
    const acquirer = repaired.acquirer || deal.acquirer;
    const target = repaired.target || deal.target;
    const headline = entry.repairedParties ? `${acquirer} / ${target}` : deal.headline;
    return {
      ...deal,
      headline,
      acquirer,
      target,
      dealType: entry.transactionType || deal.dealType,
      sourceUrl: entry.evidenceUrl || deal.sourceUrl,
      reviewStatus: entry.status,
      reviewRuleVersion: RULE_VERSION,
      reviewEngineVersion: ENGINE_VERSION,
      reviewReason: entry.reasonCode,
      reviewedAt: entry.reviewedAt,
    };
  });
  const publicVerified = output.filter(isPublicTransaction);
  if (publicVerified.length < MIN_VERIFIED) throw new Error(`Cutover invariant failed: only ${publicVerified.length} publishable verified records`);
  fs.writeFileSync(DEALS_FILE, `${JSON.stringify(output, null, 2)}\n`);
  return publicVerified.length;
}

function sampleKeys(deals, state, status, limit = 10) {
  const result = [];
  for (const deal of deals) {
    const key = recordKey(deal);
    if (state.records[key]?.status === status) result.push(key);
    if (result.length >= limit) break;
  }
  return result;
}

async function run() {
  const deals = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8'));
  if (!Array.isArray(deals) || deals.length < 10000) throw new Error(`Refusing legacy review: historical corpus is unexpectedly small (${deals?.length || 0})`);
  const state = loadState();
  const queue = deals
    .map(deal => ({ deal, key: recordKey(deal), previous: state.records[recordKey(deal)] }))
    .filter(item => shouldAttempt(item.previous))
    .slice(0, BATCH_SIZE);

  console.log(`[LEGACY REVIEW] corpus=${deals.length} queued=${queue.length} engine=${ENGINE_VERSION}`);
  let cursor = 0;
  const processed = { verified: 0, rejected: 0, needs_review: 0, error: 0 };

  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        const entry = await reviewOne(item.deal, item.previous);
        state.records[item.key] = entry;
        processed[entry.status] = (processed[entry.status] || 0) + 1;
      } catch (error) {
        state.records[item.key] = {
          ruleVersion: RULE_VERSION,
          engineVersion: ENGINE_VERSION,
          attempts: Number(item.previous?.attempts || 0) + 1,
          reviewedAt: new Date().toISOString(),
          status: 'error',
          reasonCode: 'source_request_error',
          transactionType: null,
          evidenceUrl: canonicalPrimarySourceUrl(item.deal),
          evidenceHash: null,
          error: String(error.stack || error.message || error).slice(0, 500),
        };
        processed.error++;
      }
      if (POLITENESS_MS) await sleep(POLITENESS_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  state.updatedAt = new Date().toISOString();
  state.ruleVersion = RULE_VERSION;
  state.engineVersion = ENGINE_VERSION;
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

  const summary = summarize(deals, state);
  let cutoverApplied = false;
  let publicVerifiedCount = null;
  if (AUTO_CUTOVER && summary.cutoverEligible) {
    publicVerifiedCount = applyCutover(deals, state);
    cutoverApplied = true;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    ruleVersion: RULE_VERSION,
    engineVersion: ENGINE_VERSION,
    batchSize: BATCH_SIZE,
    processedThisRun: processed,
    ...summary,
    cutoverApplied,
    publicVerifiedCount,
    safetyThresholds: {
      minVerified: MIN_VERIFIED,
      minVerifiedRatio: MIN_VERIFIED_RATIO,
      maxUnresolvedRatio: MAX_UNRESOLVED_RATIO,
      maxRejectedRatio: MAX_REJECTED_RATIO,
      requireZeroDuplicateIds: true,
    },
    samples: {
      verified: sampleKeys(deals, state, 'verified'),
      rejected: sampleKeys(deals, state, 'rejected'),
      needsReview: sampleKeys(deals, state, 'needs_review'),
    },
    publicationRule: cutoverApplied
      ? 'Historical migration complete: publish only strict verified control transactions.'
      : 'Migration in progress or safety gate not met: preserve the existing public corpus until an atomic strict cutover is safe.',
  };
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[LEGACY REVIEW]', JSON.stringify({ processed, coveragePct: summary.coveragePct, counts: summary.counts, cutoverEligible: summary.cutoverEligible, cutoverApplied }));
  return manifest;
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  RULE_VERSION, ENGINE_VERSION, stripHtml, transactionWindows, stakePercentages,
  enforceHistoricalControlGuard, recordKey, loadState, shouldAttempt, normalizeUncertain,
  reviewRecord, repairParties, duplicateIdCount, summarize, applyCutover, reviewOne, run,
};
