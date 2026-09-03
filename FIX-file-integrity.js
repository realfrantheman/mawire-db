'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const { buildArtifacts, RULE, isPublicTransaction, isLegacyIndexRow } = require('./build-public-artifacts');

const DEALS_FILE = process.env.FILE_REFRESH_DEALS_FILE || 'deals.json';
const INDEX_FILE = 'deals-index.json';
const MANIFEST_FILE = 'deals-public-manifest.json';
const ORIGIN = String(process.env.PIE_PUBLIC_ORIGIN || 'https://mawire.vercel.app').replace(/\/$/, '');
const MAX_AGE_MS = Math.max(1, Number(process.env.PIE_MAX_ARTIFACT_AGE_HOURS || 3)) * 3600000;
const MIN_DEALS = Math.max(1000, Number(process.env.PIE_MIN_PUBLIC_DEALS || 10000));
const PUBLIC_DATA_URL = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/deals-index.json';

function request(url, method = 'GET', maxBytes = 2 * 1024 * 1024, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('redirect limit exceeded'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method,
      headers: { 'User-Agent': 'mergers.news integrity monitor contact@mergers.news', Accept: '*/*' },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return request(new URL(response.headers.location, url).toString(), method, maxBytes, redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (method === 'HEAD') return;
        bytes += chunk.length;
        if (bytes > maxBytes) return req.destroy(new Error(`response exceeded ${maxBytes} bytes: ${url}`));
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

function parseJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizedParty(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, '&')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function duplicateKeys(index) {
  const seen = new Set();
  const duplicates = [];
  for (const deal of index) {
    const keys = [];
    if (deal.accessionNo) keys.push(`accession:${String(deal.accessionNo).toLowerCase()}`);
    if (deal.sourceUrl) keys.push(`source:${String(deal.sourceUrl).replace(/[?#].*$/, '').toLowerCase()}`);
    if (deal.acquirer && deal.target && deal.dateISO) {
      keys.push(`parties:${normalizedParty(deal.acquirer)}|${normalizedParty(deal.target)}|${String(deal.dateISO).slice(0, 10)}|${normalizedParty(deal.dealType)}`);
    }
    for (const key of keys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
  }
  return duplicates;
}

function validateLocalArtifacts(deals, index, manifest) {
  if (!Array.isArray(deals) || deals.length < MIN_DEALS) throw new Error(`full deal artifact unexpectedly small: ${deals.length}`);
  if (!Array.isArray(index) || index.length < MIN_DEALS) throw new Error(`public index unexpectedly small: ${index.length}`);
  if (Number(manifest.dealCount) !== index.length) throw new Error(`manifest/index count mismatch: ${manifest.dealCount} != ${index.length}`);

  const generatedAt = Date.parse(manifest.generatedAt || '');
  if (!Number.isFinite(generatedAt)) throw new Error('public manifest generatedAt is invalid');
  const age = Date.now() - generatedAt;
  if (age < -15 * 60000 || age > MAX_AGE_MS) throw new Error(`public artifact is stale: ${Math.round(age / 60000)} minutes old`);

  const expected = buildArtifacts(deals, { legacyIndex: index }).index;
  if (expected.length !== index.length) throw new Error(`rebuild/index count mismatch: ${expected.length} != ${index.length}`);
  if (JSON.stringify(expected) !== JSON.stringify(index)) throw new Error('deals-index.json does not match compatibility-safe deterministic rebuild from deals.json');

  const legacyRows = index.filter(isLegacyIndexRow);
  const strictRows = index.filter(row => !isLegacyIndexRow(row));
  const invalidStrict = strictRows.filter(deal => !isPublicTransaction(deal));
  if (invalidStrict.length) throw new Error(`public index contains ${invalidStrict.length} invalid strict transaction(s)`);
  if (manifest.legacyRecordCount !== undefined && Number(manifest.legacyRecordCount) !== legacyRows.length) {
    throw new Error(`manifest legacy count mismatch: ${manifest.legacyRecordCount} != ${legacyRows.length}`);
  }
  if (manifest.strictVerifiedCount !== undefined && Number(manifest.strictVerifiedCount) !== strictRows.length) {
    throw new Error(`manifest strict count mismatch: ${manifest.strictVerifiedCount} != ${strictRows.length}`);
  }

  const duplicates = duplicateKeys(strictRows);
  if (duplicates.length) throw new Error(`strict public index contains ${duplicates.length} duplicate identity key(s); first=${duplicates[0]}`);
  return {
    dealCount: index.length,
    legacyRecordCount: legacyRows.length,
    strictVerifiedCount: strictRows.length,
    generatedAt: manifest.generatedAt,
  };
}

async function validateOrigin(localManifest) {
  const remoteManifestResponse = await request(`${ORIGIN}/deals-public-manifest.json`);
  if (remoteManifestResponse.status !== 200) throw new Error(`origin manifest HTTP ${remoteManifestResponse.status}`);
  const remoteManifest = JSON.parse(remoteManifestResponse.text);
  if (Number(remoteManifest.dealCount) !== Number(localManifest.dealCount)) {
    throw new Error(`origin/local deal count mismatch: ${remoteManifest.dealCount} != ${localManifest.dealCount}`);
  }
  const remoteGeneratedAt = Date.parse(remoteManifest.generatedAt || '');
  if (!Number.isFinite(remoteGeneratedAt) || Date.now() - remoteGeneratedAt > MAX_AGE_MS) throw new Error('origin manifest is stale');

  const indexHead = await request(`${ORIGIN}/deals-index.json`, 'HEAD');
  if (indexHead.status !== 200) throw new Error(`origin deals-index HTTP ${indexHead.status}`);

  const app = await request(`${ORIGIN}/app.js`, 'GET', 1024 * 1024);
  if (app.status !== 200) throw new Error(`origin app.js HTTP ${app.status}`);
  if (!app.text.includes(PUBLIC_DATA_URL) || !/var\s+GITHUB_DB\s*=/.test(app.text)) {
    throw new Error('origin frontend is not configured for the Cloudflare-safe public deal index');
  }
  return { origin: ORIGIN, remoteDealCount: remoteManifest.dealCount, remoteGeneratedAt: remoteManifest.generatedAt };
}

async function run() {
  const deals = parseJson(DEALS_FILE);
  const index = parseJson(INDEX_FILE);
  const manifest = parseJson(MANIFEST_FILE);
  const local = validateLocalArtifacts(deals, index, manifest);
  const remote = await validateOrigin(manifest);
  const report = { checkedAt: new Date().toISOString(), mode: 'file-backed', ruleVersion: RULE, local, remote };
  fs.writeFileSync('pie-file-report.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log('[PIE FILE]', JSON.stringify(report));
  return report;
}

module.exports = { request, normalizedParty, duplicateKeys, validateLocalArtifacts, validateOrigin, run };

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
