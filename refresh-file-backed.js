'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const FILE_LOOKBACK_DAYS = Math.max(1, Math.min(14, Number(process.env.FILE_REFRESH_LOOKBACK_DAYS || 3)));
const MAX_FILINGS = Math.max(1, Math.min(2000, Number(process.env.FILE_REFRESH_MAX_FILINGS || 250)));
const MAX_ATTEMPTS = Math.max(1, Math.min(20, Number(process.env.FILE_REFRESH_MAX_ATTEMPTS || 5)));
const RETRY_HOURS = Math.max(1, Math.min(168, Number(process.env.FILE_REFRESH_RETRY_HOURS || 6)));
const POLITENESS_MS = Math.max(0, Math.min(5000, Number(process.env.FILE_REFRESH_POLITENESS_MS || 250)));
const STATE_FILE = process.env.FILE_REFRESH_STATE_FILE || 'file-refresh-state.json';
const DEALS_FILE = process.env.FILE_REFRESH_DEALS_FILE || 'deals.json';
const REVIEW_MANIFEST_FILE = 'deal-review-manifest.json';
const RULE_VERSION = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const USER_AGENT = 'mergers.news file-backed refresh contact@mergers.news';
const SEC_FORMS = ['DEFM14A', 'PREM14A', 'DEFA14A', 'SC TO-T', 'SC TO-T/A', 'S-4', 'S-4/A', 'SC 13E-3', 'SC 13E-3/A'];

// The existing SEC/parser and transaction-review modules expose pure functions but
// instantiate pg pools at import time. Give them a deliberately unreachable local
// URL so file-backed mode can reuse the exact extraction/review rules without ever
// attempting the retired external database connection.
process.env.LOOKBACK_DAYS = String(FILE_LOOKBACK_DAYS);
process.env.DATABASE_URL ||= 'postgres://file_refresh:file_refresh@127.0.0.1:9/file_refresh';
const sec = require('./FIX-sec-ingestor-index');
const review = require('./FIX-transaction-review');
const { canonicalPrimarySourceUrl } = require('./FIX-source-url');
const { isPublicTransaction } = require('./build-public-artifacts');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(url, accept, maxBytes, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return request(new URL(response.headers.location, url).toString(), accept, maxBytes, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}: ${url}`));
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) return req.destroy(new Error(`response exceeded ${maxBytes} bytes`));
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

async function fetchJson(url) {
  const text = await request(url, 'application/json', 20 * 1024 * 1024);
  try { return JSON.parse(text); } catch { throw new Error(`invalid JSON from ${url}`); }
}

async function fetchText(url, maxBytes = 600000) {
  return request(url, 'text/html,text/plain,application/xhtml+xml,*/*', maxBytes);
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

function cleanAccession(value) {
  return sec.cleanAccession(value);
}

async function fetchFilingDetail(filing) {
  const cik = String(filing.cik || '').replace(/\D/g, '');
  const accession = cleanAccession(filing.accession_no || filing.id);
  if (!cik || !accession) return null;
  const cleanDigits = accession.replace(/-/g, '');
  const data = await fetchJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
  const recent = data?.filings?.recent;
  if (!recent) return { company_name: data?.name || filing.entity_name, sic: data?.sic, document_url: filing.filing_url || null };
  const index = recent.accessionNumber?.findIndex(item => String(item).replace(/-/g, '') === cleanDigits);
  if (index === undefined || index < 0) {
    return { company_name: data?.name || filing.entity_name, sic: data?.sic, document_url: filing.filing_url || null };
  }
  const primary = recent.primaryDocument?.[index] || '';
  return {
    company_name: data?.name || filing.entity_name,
    sic: data?.sic,
    document_url: primary ? `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanDigits}/${primary}` : (filing.filing_url || null),
    period: recent.reportDate?.[index] || null,
    description: recent.primaryDocDescription?.[index] || null,
  };
}

function isDirectSecDocument(value) {
  return /^https:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[^/?#]+/i.test(String(value || ''));
}

function formatDate(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

function formatDealValue(cents) {
  const dollars = Number(cents || 0) / 100;
  if (!Number.isFinite(dollars) || dollars <= 0) return 'Undisclosed';
  if (dollars >= 1e12) return `$${(dollars / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (dollars >= 1e9) return `$${(dollars / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (dollars >= 1e6) return `$${(dollars / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return `$${Math.round(dollars).toLocaleString('en-US')}`;
}

function deterministicId(accession) {
  const clean = cleanAccession(accession);
  if (clean) return `sec-${clean}`;
  return `sec-${crypto.createHash('sha256').update(String(accession || '')).digest('hex').slice(0, 24)}`;
}

function normalizeIdentity(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, '&')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function identityKeys(deal) {
  const keys = [];
  if (deal.accessionNo) keys.push(`accession:${cleanAccession(deal.accessionNo).toLowerCase()}`);
  const source = String(deal.sourceUrl || '').replace(/[?#].*$/, '').toLowerCase();
  if (source) keys.push(`source:${source}`);
  if (deal.acquirer && deal.target && deal.dateISO) {
    keys.push(`parties:${normalizeIdentity(deal.acquirer)}|${normalizeIdentity(deal.target)}|${String(deal.dateISO).slice(0, 10)}|${normalizeIdentity(deal.dealType)}`);
  }
  return keys;
}

function existingIdentitySet(deals) {
  const set = new Set();
  for (const deal of deals || []) for (const key of identityKeys(deal)) set.add(key);
  return set;
}

function loadState(file = STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid state');
    if (!parsed.filings || typeof parsed.filings !== 'object') parsed.filings = {};
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[FILE REFRESH] state reset:', error.message);
    return { version: 1, ruleVersion: RULE_VERSION, filings: {} };
  }
}

function shouldAttempt(accession, state, now = Date.now()) {
  const entry = state?.filings?.[accession];
  if (!entry) return true;
  if (entry.ruleVersion !== RULE_VERSION) return true;
  if (entry.status === 'verified' || entry.status === 'rejected') return false;
  if (Number(entry.attempts || 0) >= MAX_ATTEMPTS) return false;
  const last = Date.parse(entry.lastAttemptAt || '');
  return !Number.isFinite(last) || now - last >= RETRY_HOURS * 3600000;
}

function markAttempt(state, accession, status, reasonCode, errorMessage = null) {
  const previous = state.filings[accession] || {};
  state.filings[accession] = {
    attempts: Number(previous.ruleVersion === RULE_VERSION ? previous.attempts || 0 : 0) + 1,
    status,
    reasonCode: reasonCode || null,
    error: errorMessage ? String(errorMessage).slice(0, 500) : null,
    lastAttemptAt: new Date().toISOString(),
    ruleVersion: RULE_VERSION,
  };
}

function pruneState(state, now = Date.now()) {
  const cutoff = now - 45 * 86400000;
  for (const [accession, entry] of Object.entries(state.filings || {})) {
    const last = Date.parse(entry.lastAttemptAt || '');
    if (Number.isFinite(last) && last < cutoff) delete state.filings[accession];
  }
  state.version = 1;
  state.ruleVersion = RULE_VERSION;
  state.updatedAt = new Date(now).toISOString();
  return state;
}

function candidateToDeal({ filing, filingType, detail, info, sourceUrl, reviewResult, reviewedAt = new Date().toISOString() }) {
  if (!reviewResult || reviewResult.status !== 'verified') return null;
  const acquirer = info?.extracted_acquirer_name;
  const target = info?.extracted_target_name;
  if (!review.distinctParties(acquirer, target)) return null;
  if (!isDirectSecDocument(sourceUrl)) return null;
  const dateISO = filing.filing_date || info.announcement_date || info.filing_date;
  const year = Number(String(dateISO || '').slice(0, 4)) || null;
  const dealValueNum = info.deal_value_cents ? Number(info.deal_value_cents) / 100 : 0;
  const dealType = reviewResult.transactionType;
  const form = filingType;
  const source = canonicalPrimarySourceUrl({
    sourceUrl,
    documentUrl: sourceUrl,
    edgarUrl: sourceUrl,
    filingType: form,
    accessionNo: cleanAccession(filing.accession_no || filing.id),
    filingCik: filing.cik,
  }) || sourceUrl;
  const date = formatDate(dateISO);
  const deal = {
    id: deterministicId(filing.accession_no || filing.id),
    headline: `${acquirer} / ${target}`,
    subheadline: `SEC Form ${form} filed${date ? ` on ${date}` : ''}`,
    acquirer,
    target,
    dealType,
    status: 'Announced',
    dealValue: formatDealValue(info.deal_value_cents),
    dealValueNum,
    sector: info.sector || null,
    date,
    year,
    dateISO,
    isPrivateEquity: dealType === 'LBO / Going-Private',
    isHostile: false,
    summary: `${acquirer} and ${target} are documented in SEC Form ${form}${date ? ` filed on ${date}` : ''}.`,
    body: `${acquirer} and ${target} are documented in SEC Form ${form}. The transaction passed the ${RULE_VERSION} primary-source control-transaction review rule.`,
    source: 'SEC Filing',
    sourceUrl: source,
    filingType: form,
    edgarUrl: source,
    extractionMethod: 'sec_filing',
    sourceType: 'sec_edgar',
    sourceName: 'SEC EDGAR',
    accessionNo: cleanAccession(filing.accession_no || filing.id),
    confidence: Number(info.source_confidence || 0.8),
    reviewStatus: 'verified',
    reviewRuleVersion: RULE_VERSION,
    reviewedAt,
    breaking: year === new Date(reviewedAt).getUTCFullYear(),
  };
  return isPublicTransaction(deal) ? deal : null;
}

async function fetchAllRecentFilings() {
  const all = [];
  const failures = [];
  for (const filingType of SEC_FORMS) {
    try {
      const rows = await sec.fetchRecentFilings(filingType);
      console.log(`[FILE REFRESH] ${filingType}: ${rows.length} recent filing(s)`);
      for (const filing of rows) all.push({ filing, filingType });
    } catch (error) {
      failures.push(`${filingType}: ${error.message}`);
      console.error(`[FILE REFRESH] ${filingType} source failure:`, error.message);
    }
  }
  if (failures.length) throw new Error(`SEC source coverage incomplete: ${failures.join('; ')}`);
  const byAccession = new Map();
  for (const item of all) {
    const accession = cleanAccession(item.filing.accession_no || item.filing.id);
    if (accession && !byAccession.has(accession)) byAccession.set(accession, item);
  }
  return [...byAccession.values()].sort((a, b) => String(b.filing.filing_date || '').localeCompare(String(a.filing.filing_date || '')));
}

async function processCandidate(item) {
  const { filing, filingType } = item;
  const detail = await fetchFilingDetail(filing);
  const sourceUrl = detail?.document_url || filing.filing_url || '';
  if (!isDirectSecDocument(sourceUrl)) throw new Error('primary SEC document URL unavailable');
  const html = await fetchText(sourceUrl);
  const text = stripHtml(html);
  if (text.length < 100) throw new Error('primary SEC document text unavailable');
  const info = sec.extractDealInfo(filing, detail, filingType, text);
  const record = {
    headline: info.headline,
    acquirer: info.extracted_acquirer_name,
    target: info.extracted_target_name,
    filingType,
    sourceType: 'sec_edgar',
    extractionMethod: 'sec_filing',
    rawExtractedSnippet: info.raw_extracted_snippet,
    sourceRawContent: text.slice(0, 10000),
  };
  const result = review.reviewEvidence(record, text);
  return { detail, sourceUrl, info, reviewResult: result };
}

async function run() {
  const deals = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8'));
  if (!Array.isArray(deals) || deals.length < 1000) throw new Error(`Refusing file-backed refresh: ${DEALS_FILE} is missing or unexpectedly small`);
  const identities = existingIdentitySet(deals);
  const state = loadState();
  const recent = await fetchAllRecentFilings();
  const candidates = recent.filter(({ filing }) => {
    const accession = cleanAccession(filing.accession_no || filing.id);
    return accession && !identities.has(`accession:${accession.toLowerCase()}`) && shouldAttempt(accession, state);
  }).slice(0, MAX_FILINGS);

  console.log(`[FILE REFRESH] ${recent.length} unique recent filing(s); ${candidates.length} queued; current public base ${deals.length}`);
  const counts = { queued: candidates.length, verified: 0, rejected: 0, needs_review: 0, errors: 0, duplicates: 0 };
  const additions = [];

  for (const item of candidates) {
    const accession = cleanAccession(item.filing.accession_no || item.filing.id);
    try {
      const processed = await processCandidate(item);
      const status = processed.reviewResult.status;
      markAttempt(state, accession, status, processed.reviewResult.reasonCode);
      counts[status] = (counts[status] || 0) + 1;
      if (status === 'verified') {
        const deal = candidateToDeal({ ...processed, filing: item.filing, filingType: item.filingType });
        if (!deal) {
          counts.verified--;
          counts.needs_review++;
          Object.assign(state.filings[accession], { status: 'needs_review', reasonCode: 'verified_result_failed_publication_invariants' });
        } else {
          const duplicate = identityKeys(deal).some(key => identities.has(key));
          if (duplicate) {
            counts.verified--;
            counts.duplicates++;
            Object.assign(state.filings[accession], { status: 'verified', reasonCode: 'duplicate_existing_transaction' });
          } else {
            additions.push(deal);
            for (const key of identityKeys(deal)) identities.add(key);
          }
        }
      }
    } catch (error) {
      counts.errors++;
      markAttempt(state, accession, 'error', 'processing_error', error.message);
      console.error(`[FILE REFRESH] ${accession} failed:`, error.message);
    }
    if (POLITENESS_MS) await sleep(POLITENESS_MS);
  }

  const attempted = candidates.length;
  const errorBudget = Math.max(5, Math.ceil(attempted * 0.2));
  if (counts.errors > errorBudget) {
    throw new Error(`File-backed refresh exceeded error budget: ${counts.errors}/${attempted}`);
  }

  if (additions.length) {
    fs.writeFileSync(DEALS_FILE, `${JSON.stringify([...additions, ...deals], null, 2)}\n`);
  }
  pruneState(state);
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: 'file-backed-sec',
    ruleVersion: RULE_VERSION,
    lookbackDays: FILE_LOOKBACK_DAYS,
    processedThisRun: counts,
    additions: additions.length,
    publicationRule: 'Verified primary-source control transactions only.',
  };
  fs.writeFileSync(REVIEW_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[FILE REFRESH] complete', JSON.stringify({ ...counts, additions: additions.length }));
  return { additions, counts, manifest };
}

module.exports = {
  RULE_VERSION, SEC_FORMS, cleanAccession, stripHtml, isDirectSecDocument, formatDate,
  formatDealValue, deterministicId, normalizeIdentity, identityKeys, existingIdentitySet,
  loadState, shouldAttempt, markAttempt, pruneState, candidateToDeal, processCandidate, run,
};

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
