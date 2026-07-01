#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { applyOverrides, dedupeRecords, normalizeRecord, normalizedName, recordKey } = require('./ipo-data');

const ROOT = __dirname;
const OUTPUT = process.env.IPO_OUTPUT || path.join(ROOT, 'ipos.json');
const SITE_OUTPUT = process.env.SITE_IPO_OUTPUT || null;
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(ROOT, 'ipo-overrides.json'), 'utf8'));
const FORMS = ['S-1', 'S-1/A', 'F-1', 'F-1/A', '424B4', '424B1', 'EFFECT', 'RW', 'RW WD'];
const CONFIG = {
  lookbackYears: Number(process.env.IPO_LOOKBACK_YEARS || 8),
  maxMetadata: Number(process.env.IPO_MAX_METADATA || 12000),
  maxFullText: Number(process.env.IPO_MAX_FULL_TEXT || 40),
  requestDelayMs: Number(process.env.IPO_REQUEST_DELAY_MS || 140),
  timeoutMs: Number(process.env.IPO_REQUEST_TIMEOUT_MS || 20000),
  maxBytes: Number(process.env.IPO_RESPONSE_MAX_BYTES || 6_000_000),
  publishRetries: Number(process.env.IPO_PUBLISH_RETRIES || 4),
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function request(url, asText = false, redirects = 0) {
  if (redirects > 4) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: {
      'User-Agent': 'mergers.news IPO lifecycle index contact@mergers.news',
      Accept: asText ? 'text/html,text/plain' : 'application/json',
    } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return request(new URL(res.headers.location, url).toString(), asText, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > CONFIG.maxBytes) req.destroy(new Error('response size limit exceeded'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (asText) return resolve(body);
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`invalid JSON from ${url}`)); }
      });
    });
    req.setTimeout(CONFIG.timeoutMs, () => req.destroy(new Error(`timeout for ${url}`)));
    req.on('error', reject);
  });
}
async function requestWithRetry(url, asText = false, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await request(url, asText); }
    catch (error) {
      lastError = error;
      if (!/HTTP (?:429|5\d\d)|timeout/i.test(error.message) || attempt === attempts - 1) throw error;
      await sleep(CONFIG.requestDelayMs * Math.pow(2, attempt + 2));
    }
  }
  throw lastError;
}

function cleanName(source = {}) {
  const raw = Array.isArray(source.display_names) ? source.display_names[0] : source.display_names || source.entity_name || '';
  return String(raw).replace(/\s*\([^)]*CIK\s+\d+[^)]*\)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
}
function hitCik(hit) {
  const source = hit._source || {};
  const candidate = source.ciks?.[0] || source.entity_id || String(source.display_names?.[0] || '').match(/CIK\s+0*(\d+)/i)?.[1];
  return String(candidate || '').replace(/^0+/, '');
}
function directFilingUrl(hit) {
  const [accession = '', filename = ''] = String(hit._id || '').split(':');
  const cik = hitCik(hit);
  if (!cik || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  const folder = accession.replace(/-/g, '');
  return filename
    ? `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${filename}`
    : `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${accession}-index.html`;
}
function sectorFromSic(value) {
  const sic = Number(Array.isArray(value) ? value[0] : value);
  if (sic >= 2800 && sic <= 2899 || sic >= 8000 && sic <= 8099) return 'Healthcare';
  if (sic >= 6000 && sic <= 6499) return 'Financial Services';
  if (sic >= 6500 && sic <= 6799) return 'Real Estate';
  if (sic >= 4800 && sic <= 4899) return 'Telecommunications';
  if (sic >= 4900 && sic <= 4999) return 'Energy';
  if (sic >= 2000 && sic <= 3999) return 'Industrials';
  if (sic >= 5000 && sic <= 5999) return 'Consumer';
  if (sic >= 7300 && sic <= 7399) return 'Technology';
  return 'Other';
}
function hitToCandidate(hit, form) {
  const source = hit._source || {};
  const name = cleanName(source);
  const date = String(source.file_date || '').slice(0, 10) || null;
  const url = directFilingUrl(hit);
  const accession = String(hit._id || '').split(':')[0] || null;
  if (!name || !date || !url) return null;
  return {
    name, legalName: name, sector: sectorFromSic(source.sics), industry: source.sic_description || null,
    cik: hitCik(hit) || null, filingDate: date, latestUpdateDate: date, filingType: form,
    sourceUrl: url, source: 'SEC', accession,
    notes: `${name} filed ${form} with the SEC on ${date}.`, tags: [],
    lifecycleFilings: [{ form, date, url, accession }],
    sources: [{ title: `${name} ${form}`, url, publisher: 'SEC', date, type: 'filing', confidence: 1 }],
  };
}
function mergeLifecycle(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.cik ? `cik:${record.cik}` : `name:${normalizedName(record.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => String(b.filingDate || '').localeCompare(String(a.filingDate || '')));
    const latest = group[0];
    const lifecycleFilings = group.flatMap(item => item.lifecycleFilings || []).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const seen = new Set();
    const sources = group.flatMap(item => item.sources || []).filter(source => {
      if (seen.has(source.url)) return false; seen.add(source.url); return true;
    });
    return normalizeRecord({ ...latest, lifecycleFilings, sources, latestUpdateDate: lifecycleFilings[0]?.date || latest.latestUpdateDate });
  });
}
function parseTextMetadata(text) {
  const plain = String(text || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ');
  const ticker = plain.match(/(?:ticker|trading|symbol)\s+(?:symbol\s+)?[“"']?([A-Z][A-Z0-9.]{0,5})[”"']?/i)?.[1] || null;
  const exchange = /nasdaq/i.test(plain) ? 'Nasdaq' : /nyse american/i.test(plain) ? 'NYSE American' : /new york stock exchange|\bnyse\b/i.test(plain) ? 'NYSE' : null;
  const offering = plain.match(/(?:aggregate offering|offering price|proceeds)[^$]{0,80}\$\s*([\d,.]+)\s*(billion|million)?/i);
  let valuationNum = null;
  if (offering) valuationNum = Number(offering[1].replace(/,/g, '')) * (/billion/i.test(offering[2] || '') ? 1e9 : /million/i.test(offering[2] || '') ? 1e6 : 1);
  return { ticker, exchange, valuationNum: Number.isFinite(valuationNum) ? valuationNum : null };
}
function humanValue(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

async function searchForm(form, start, end, stats, formBudget) {
  const output = [];
  for (let from = 0; output.length < formBudget && stats.metadata < CONFIG.maxMetadata; from += 100) {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(form)}&dateRange=custom&startdt=${start}&enddt=${end}&from=${from}&size=100`;
    let data;
    try { data = await requestWithRetry(url); } catch (error) { stats.errors.push({ form, start, message: error.message }); break; }
    const hits = data?.hits?.hits || [];
    for (const hit of hits) {
      const candidate = hitToCandidate(hit, form);
      if (candidate) output.push(candidate);
    }
    stats.metadata += hits.length;
    if (hits.length < 100 || !hits.length || stats.metadata >= CONFIG.maxMetadata || output.length >= formBudget) break;
    await sleep(CONFIG.requestDelayMs);
  }
  return output;
}
async function fetchLifecycleCandidates() {
  const year = new Date().getUTCFullYear();
  const stats = { metadata: 0, fullText: 0, errors: [] };
  const records = [];
  const formBudget = Math.max(100, Math.floor(CONFIG.maxMetadata / FORMS.length));
  for (const form of FORMS) {
    for (let current = year; current >= year - CONFIG.lookbackYears + 1 && stats.metadata < CONFIG.maxMetadata; current--) {
      records.push(...await searchForm(form, `${current}-01-01`, `${current}-12-31`, stats, formBudget - records.filter(record => record.filingType === form).length));
      await sleep(CONFIG.requestDelayMs);
    }
  }
  let merged = mergeLifecycle(records);
  const enrichable = merged.filter(record => ['filed', 'amended', 'priced'].includes(record.status)).slice(0, CONFIG.maxFullText);
  for (const record of enrichable) {
    try {
      const html = await requestWithRetry(record.sourceUrl, true, 2);
      const parsed = parseTextMetadata(html);
      Object.assign(record, {
        ticker: parsed.ticker || record.ticker, exchange: parsed.exchange || record.exchange,
        valuationNum: parsed.valuationNum || record.valuationNum,
        valuation: humanValue(parsed.valuationNum) || record.valuation,
      });
      stats.fullText++;
    } catch (error) { stats.errors.push({ cik: record.cik, message: error.message }); }
    await sleep(CONFIG.requestDelayMs);
  }
  return { records: merged, stats };
}
function readExisting() {
  if (!fs.existsSync(OUTPUT)) return [];
  const payload = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  return Array.isArray(payload) ? payload : [];
}
function buildArtifact(existing, fetched = []) {
  const fetchedKeys = new Set(fetched.map(record => recordKey(record)));
  const preserved = existing.filter(record => !fetchedKeys.has(recordKey(normalizeRecord(record))));
  const records = applyOverrides(dedupeRecords(preserved.concat(fetched)), OVERRIDES);
  const order = { priced: 0, amended: 1, filed: 2, delayed: 3, private: 4, rumored: 5, listed: 6, completed: 7, withdrawn: 8, unknown: 9 };
  return records.sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99) || String(b.latestUpdateDate).localeCompare(String(a.latestUpdateDate)) || a.name.localeCompare(b.name));
}
function validateArtifact(records) {
  const errors = []; const ids = new Set(); const slugs = new Set();
  for (const [index, record] of records.entries()) {
    for (const key of ['id', 'slug', 'name', 'status', 'latestUpdateDate']) if (!record[key]) errors.push(`${index}: missing ${key}`);
    if (!record.sourceUrl && !record.sources?.length) errors.push(`${record.slug}: missing sources`);
    if (ids.has(record.id)) errors.push(`${record.slug}: duplicate id`); ids.add(record.id);
    if (slugs.has(record.slug)) errors.push(`${record.slug}: duplicate slug`); slugs.add(record.slug);
    if (record.sources?.some(source => !/^https?:\/\//i.test(source.url))) errors.push(`${record.slug}: unsafe source`);
    for (const edge of [...(record.dependencyGraph?.publicCompaniesDependingOnIPO || []), ...(record.dependencyGraph?.publicCompaniesIPOCompanyDependsOn || [])]) {
      if (!edge.company || !edge.relationship || !edge.sourceUrl || Number(edge.confidence) < 0.6) errors.push(`${record.slug}: invalid dependency edge`);
    }
    if (record.dependencyIngestion && (!record.dependencyIngestion.parserVersion || !record.dependencyIngestion.attemptedAt ||
        !['complete', 'no_evidence', 'no_sec_source', 'partial_error', 'fetch_failed'].includes(record.dependencyIngestion.status))) {
      errors.push(`${record.slug}: invalid dependency ingestion telemetry`);
    }
  }
  const spacex = records.find(record => record.cik === '1181412' || /^spacex$/i.test(record.name));
  if (spacex && !['listed', 'completed'].includes(spacex.status)) errors.push('SpaceX must not be active after verified Nasdaq listing');
  if (errors.length) throw new Error(`IPO validation failed:\n${errors.slice(0, 50).join('\n')}`);
  return { count: records.length, active: records.filter(record => ['rumored', 'filed', 'amended', 'priced', 'delayed', 'private'].includes(record.status)).length };
}
function writeArtifact(records) {
  const json = `${JSON.stringify(records, null, 2)}\n`;
  fs.writeFileSync(OUTPUT, json);
  if (SITE_OUTPUT) fs.writeFileSync(SITE_OUTPUT, json);
}
function remoteContentMatches(current, content) {
  return Boolean(current?.content && String(current.content).replace(/\s/g, '') === content);
}
function shouldRetryGithubPublish(error, attempt, maxAttempts = CONFIG.publishRetries) {
  return Number(error?.statusCode) === 409 && attempt < maxAttempts;
}
async function publishArtifact(records) {
  const token = process.env.GITHUB_TOKEN || process.env.MAWIRE_TOKEN;
  if (!token || process.env.PUBLISH_IPOS !== 'true') return;
  const owner = process.env.GITHUB_OWNER || 'realfrantheman';
  const repo = process.env.GITHUB_REPO || 'mawire-db';
  const apiPath = `/repos/${owner}/${repo}/contents/ipos.json`;
  const api = (method, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mergers.news/ipos',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = { raw: data }; }
        if (res.statusCode < 300) return resolve(json);
        const error = new Error(`GitHub ${res.statusCode}: ${data.slice(0, 500)}`);
        error.statusCode = res.statusCode;
        error.body = json;
        reject(error);
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  const content = Buffer.from(`${JSON.stringify(records, null, 2)}\n`).toString('base64');
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.publishRetries; attempt++) {
    const current = await api('GET');
    if (remoteContentMatches(current, content)) {
      console.log('[IPO] Remote ipos.json already matches generated artifact');
      return;
    }
    try {
      await api('PUT', {
        message: `IPO lifecycle data: ${records.length} verified records`,
        sha: current.sha,
        content,
        branch: 'main',
      });
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetryGithubPublish(error, attempt)) throw error;
      const delay = Math.min(5000, 500 * Math.pow(2, attempt - 1));
      console.warn(`[IPO] GitHub content SHA conflict while publishing ipos.json; retry ${attempt}/${CONFIG.publishRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
  if (lastError) throw lastError;
}

async function main() {
  const normalizeOnly = process.argv.includes('--normalize-existing');
  const existing = readExisting();
  const fetched = normalizeOnly ? { records: [], stats: { metadata: 0, fullText: 0, errors: [] } } : await fetchLifecycleCandidates();
  const records = buildArtifact(existing, fetched.records);
  const summary = validateArtifact(records);
  if (process.env.IPO_DRY_RUN !== 'true') writeArtifact(records);
  await publishArtifact(records);
  console.log(JSON.stringify({ mode: normalizeOnly ? 'normalize-existing' : 'fetch', ...summary, ...fetched.stats, output: OUTPUT, siteOutput: SITE_OUTPUT }, null, 2));
}

module.exports = { FORMS, CONFIG, cleanName, hitCik, directFilingUrl, sectorFromSic, hitToCandidate,
  mergeLifecycle, parseTextMetadata, buildArtifact, validateArtifact, fetchLifecycleCandidates, publishArtifact,
  remoteContentMatches, shouldRetryGithubPublish };

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
