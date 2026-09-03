'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

const refresh = require('./refresh-file-backed');
const efts = require('./FIX-sec-efts');
const sec = require('./FIX-sec-ingestor-index');
const review = require('./FIX-transaction-review');

const FILE_LOOKBACK_DAYS = Math.max(1, Math.min(14, Number(process.env.FILE_REFRESH_LOOKBACK_DAYS || 3)));
const MAX_FILINGS = Math.max(1, Math.min(2000, Number(process.env.FILE_REFRESH_MAX_FILINGS || 250)));
const POLITENESS_MS = Math.max(0, Math.min(5000, Number(process.env.FILE_REFRESH_POLITENESS_MS || 250)));
const MAX_DOCUMENT_BYTES = Math.max(600000, Math.min(32 * 1024 * 1024, Number(process.env.FILE_REFRESH_MAX_DOCUMENT_BYTES || 12 * 1024 * 1024)));
const DEALS_FILE = process.env.FILE_REFRESH_DEALS_FILE || 'deals.json';
const STATE_FILE = process.env.FILE_REFRESH_STATE_FILE || 'file-refresh-state.json';
const REVIEW_MANIFEST_FILE = 'deal-review-manifest.json';
const USER_AGENT = 'mergers.news file-backed refresh contact@mergers.news';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendBoundedChunk(state, chunk, maxBytes = MAX_DOCUMENT_BYTES) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.totalBytes += buffer.length;
  const remaining = Math.max(0, maxBytes - state.capturedBytes);
  if (remaining > 0) {
    const piece = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    state.chunks.push(piece);
    state.capturedBytes += piece.length;
  }
  if (state.totalBytes > maxBytes) state.truncated = true;
  return state;
}

function requestTextPrefix(url, maxBytes = MAX_DOCUMENT_BYTES, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,text/plain,application/xhtml+xml,*/*',
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestTextPrefix(new URL(response.headers.location, url).toString(), maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const state = { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false };
      response.on('data', chunk => appendBoundedChunk(state, chunk, maxBytes));
      response.on('end', () => resolve({
        text: Buffer.concat(state.chunks).toString('utf8'),
        truncated: state.truncated,
        capturedBytes: state.capturedBytes,
        totalBytes: state.totalBytes,
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

function requestJson(url, maxBytes = 20 * 1024 * 1024, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(new URL(response.headers.location, url).toString(), maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error(`JSON response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

async function fetchFilingDetail(filing) {
  const cik = String(filing.cik || '').replace(/\D/g, '');
  const accession = refresh.cleanAccession(filing.accession_no || filing.id);
  if (!cik || !accession) return null;
  const cleanDigits = accession.replace(/-/g, '');
  const data = await requestJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
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

async function fetchAllRecentFilings() {
  const all = [];
  const failures = [];
  for (const filingType of efts.ROOT_FORMS) {
    try {
      const rows = await efts.fetchRecentFilings(filingType, { lookbackDays: FILE_LOOKBACK_DAYS });
      console.log(`[FILE REFRESH] ${filingType}: ${rows.length} recent filing(s)`);
      for (const filing of rows) all.push({ filing, filingType: filing.filing_type || filingType });
    } catch (error) {
      failures.push(`${filingType}: ${error.message}`);
      console.error(`[FILE REFRESH] ${filingType} source failure:`, error.message);
    }
  }
  if (failures.length) throw new Error(`SEC source coverage incomplete: ${failures.join('; ')}`);
  const byAccession = new Map();
  for (const item of all) {
    const accession = refresh.cleanAccession(item.filing.accession_no || item.filing.id);
    if (!accession) continue;
    const current = byAccession.get(accession);
    const currentPrimary = current && Number(current.filing?.raw?.sequence) === 1;
    const candidatePrimary = Number(item.filing?.raw?.sequence) === 1;
    if (!current || (!currentPrimary && candidatePrimary)) byAccession.set(accession, item);
  }
  return [...byAccession.values()].sort((a, b) => String(b.filing.filing_date || '').localeCompare(String(a.filing.filing_date || '')));
}

async function processCandidate(item) {
  const { filing, filingType } = item;
  const detail = await fetchFilingDetail(filing);
  const sourceUrl = detail?.document_url || filing.filing_url || '';
  if (!refresh.isDirectSecDocument(sourceUrl)) throw new Error('primary SEC document URL unavailable');

  const fetched = await requestTextPrefix(sourceUrl);
  const text = refresh.stripHtml(fetched.text);
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
  let reviewResult = review.reviewEvidence(record, text);

  // A truncated primary filing can prove a deal, but lack of proof in a prefix must
  // never become a permanent rejection. Preserve it for a later/full review instead.
  if (fetched.truncated && reviewResult.status !== 'verified') {
    reviewResult = {
      ...reviewResult,
      status: 'needs_review',
      reasonCode: 'primary_source_truncated_before_verification',
      evidenceExcerpt: null,
    };
  }
  if (fetched.truncated) {
    console.log(`[FILE REFRESH] ${refresh.cleanAccession(filing.accession_no || filing.id)} parsed bounded prefix ${fetched.capturedBytes}/${fetched.totalBytes} bytes; review=${reviewResult.status}`);
  }
  return { detail, sourceUrl, info, reviewResult };
}

async function run() {
  const deals = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8'));
  if (!Array.isArray(deals) || deals.length < 1000) throw new Error(`Refusing file-backed refresh: ${DEALS_FILE} is missing or unexpectedly small`);
  const identities = refresh.existingIdentitySet(deals);
  const state = refresh.loadState(STATE_FILE);
  const recent = await fetchAllRecentFilings();
  const candidates = recent.filter(({ filing }) => {
    const accession = refresh.cleanAccession(filing.accession_no || filing.id);
    return accession && !identities.has(`accession:${accession.toLowerCase()}`) && refresh.shouldAttempt(accession, state);
  }).slice(0, MAX_FILINGS);

  console.log(`[FILE REFRESH] ${recent.length} unique recent filing(s); ${candidates.length} queued; current public base ${deals.length}`);
  const counts = { queued: candidates.length, verified: 0, rejected: 0, needs_review: 0, errors: 0, duplicates: 0 };
  const additions = [];

  for (const item of candidates) {
    const accession = refresh.cleanAccession(item.filing.accession_no || item.filing.id);
    try {
      const processed = await processCandidate(item);
      const status = processed.reviewResult.status;
      refresh.markAttempt(state, accession, status, processed.reviewResult.reasonCode);
      counts[status] = (counts[status] || 0) + 1;
      if (status === 'verified') {
        const deal = refresh.candidateToDeal({ ...processed, filing: item.filing, filingType: item.filingType });
        if (!deal) {
          counts.verified--;
          counts.needs_review++;
          Object.assign(state.filings[accession], { status: 'needs_review', reasonCode: 'verified_result_failed_publication_invariants' });
        } else {
          const duplicate = refresh.identityKeys(deal).some(key => identities.has(key));
          if (duplicate) {
            counts.verified--;
            counts.duplicates++;
            Object.assign(state.filings[accession], { status: 'verified', reasonCode: 'duplicate_existing_transaction' });
          } else {
            additions.push(deal);
            for (const key of refresh.identityKeys(deal)) identities.add(key);
          }
        }
      }
    } catch (error) {
      counts.errors++;
      refresh.markAttempt(state, accession, 'error', 'processing_error', error.message);
      console.error(`[FILE REFRESH] ${accession} failed:`, error.message);
    }
    if (POLITENESS_MS) await sleep(POLITENESS_MS);
  }

  const errorBudget = Math.max(5, Math.ceil(candidates.length * 0.2));
  if (counts.errors > errorBudget) {
    throw new Error(`File-backed refresh exceeded error budget: ${counts.errors}/${candidates.length}`);
  }

  if (additions.length) fs.writeFileSync(DEALS_FILE, `${JSON.stringify([...additions, ...deals], null, 2)}\n`);
  refresh.pruneState(state);
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: 'file-backed-sec',
    ruleVersion: refresh.RULE_VERSION,
    lookbackDays: FILE_LOOKBACK_DAYS,
    maxDocumentBytes: MAX_DOCUMENT_BYTES,
    processedThisRun: counts,
    additions: additions.length,
    publicationRule: 'Verified primary-source control transactions only.',
  };
  fs.writeFileSync(REVIEW_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[FILE REFRESH] complete', JSON.stringify({ ...counts, additions: additions.length }));
  return { additions, counts, manifest };
}

module.exports = { MAX_DOCUMENT_BYTES, appendBoundedChunk, requestTextPrefix, fetchFilingDetail, fetchAllRecentFilings, processCandidate, run };

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
