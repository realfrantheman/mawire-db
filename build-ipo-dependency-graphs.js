#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { isActive, normalizeGraph } = require('./ipo-data');

const FILE = process.env.IPO_OUTPUT || 'ipos.json';
const PARSER_VERSION = 'sec-dependency-v2';
const REGISTRY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const CACHE_DIR = process.env.DEPENDENCY_CACHE_DIR || path.join('.cache', 'ipo-dependencies');
const REGISTRY_FILE = process.env.DEPENDENCY_REGISTRY_PATH || path.join(CACHE_DIR, 'sec-company-registry.json');
const GENERATED_METHODS = new Set(['deterministic-sec-dependency-v1', PARSER_VERSION]);
const GENERIC_NAMES = new Set(['general', 'global', 'international', 'national', 'united', 'group', 'holdings', 'company', 'corporation', 'technologies']);

const SEED_COMPANIES = [
  ['Amazon', 'AMZN', ['Amazon Web Services', 'AWS'], 'cloud provider'],
  ['Microsoft', 'MSFT', ['Microsoft Azure', 'Azure'], 'cloud provider'],
  ['Alphabet', 'GOOGL', ['Google Cloud Platform', 'Google Cloud', 'Google'], 'cloud provider'],
  ['NVIDIA', 'NVDA', ['NVIDIA', 'Nvidia'], 'chip supplier'],
  ['Apple', 'AAPL', ['Apple App Store', 'App Store', 'Apple'], 'distribution platform'],
  ['Meta Platforms', 'META', ['Meta Platforms', 'Facebook', 'Instagram'], 'customer acquisition channel'],
  ['Oracle', 'ORCL', ['Oracle Cloud', 'Oracle'], 'cloud provider'],
  ['Salesforce', 'CRM', ['Salesforce'], 'technology provider'],
  ['Visa', 'V', ['Visa'], 'payment processor'],
  ['Mastercard', 'MA', ['Mastercard'], 'payment processor'],
  ['Shopify', 'SHOP', ['Shopify'], 'distribution platform'],
  ['Taiwan Semiconductor Manufacturing', 'TSM', ['Taiwan Semiconductor Manufacturing', 'TSMC'], 'chip manufacturer'],
  ['Samsung Electronics', '005930', ['Samsung Electronics'], 'manufacturer'],
].map(([company, ticker, aliases, providerRelationship]) => ({ company, ticker, aliases, providerRelationship, seeded: true }));

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function stripHtml(html) {
  return cleanText(String(html || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16))).replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value))));
}
function sentences(text) { return stripHtml(text).match(/[^.!?]{25,900}[.!?]/g) || []; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizedName(value) {
  return cleanText(value).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(?:incorporated|inc|corp(?:oration)?|company|co|limited|ltd|plc|holdings?|group|class [a-z])\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function safeAlias(value, allowSingleWord = false) {
  const alias = cleanText(value).replace(/\s+(?:Inc\.?|Corp\.?|Corporation|Company|Co\.?|Ltd\.?|Limited|PLC)$/i, '').trim();
  if (alias.length < 5 || (!allowSingleWord && alias.split(/\s+/).length < 2) || (alias.split(/\s+/).length === 1 && GENERIC_NAMES.has(alias.toLowerCase()))) return null;
  return alias;
}
function mergeRegistry(entries) {
  const byCompany = new Map();
  for (const entry of entries) {
    const ticker = cleanText(entry.ticker).toUpperCase();
    if (!ticker || !entry.company) continue;
    const key = normalizedName(entry.company);
    const current = byCompany.get(key) || { company: cleanText(entry.company), ticker, aliases: [], providerRelationship: entry.providerRelationship || null, seeded: Boolean(entry.seeded) };
    for (const value of [entry.company, ...(entry.aliases || [])]) {
      const alias = safeAlias(value, Boolean(entry.seeded));
      if (alias && !current.aliases.some(item => item.toLowerCase() === alias.toLowerCase())) current.aliases.push(alias);
    }
    if (entry.providerRelationship) { current.providerRelationship = entry.providerRelationship; current.company = cleanText(entry.company); current.ticker = ticker; current.seeded = true; }
    byCompany.set(key, current);
  }
  const result = [...byCompany.values()].filter(entry => entry.aliases.length);
  for (const entry of result) Object.defineProperty(entry, '_aliasMatchers', { value: entry.aliases.map(value => ({ value, pattern: new RegExp(`\\b${escapeRegExp(value)}\\b`, entry.seeded ? 'i' : '') })) });
  Object.defineProperty(result, '_prepared', { value: true });
  return result;
}
function registryFromSec(payload) {
  if (!payload || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) return [];
  const fields = Object.fromEntries(payload.fields.map((field, index) => [field, index]));
  return payload.data.map(row => ({
    company: row[fields.name], ticker: row[fields.ticker], aliases: [row[fields.name]], exchange: row[fields.exchange],
  })).filter(entry => entry.company && entry.ticker);
}

const MATERIAL_SIGNAL = /\b(?:depend(?:s|ed|ence)? on|rely|relies|relied|key customer|major customer|largest customer|material customer|key supplier|sole supplier|single-source|exclusive supplier|material supplier|cloud provider|payment processor|hosted by|powered by|provided by|supplied by|manufactured by|purchase(?:s|d)? from|accounted for \d+(?:\.\d+)?%|uses? our|licenses? our|deploys? our|critical provider|exclusive provider)(?:\b|(?<=%))/i;
const NON_DEPENDENCY = /\b(?:plan(?:s|ned)? to|intend(?:s|ed)? to|marketing|promotional|advertis(?:e|ing)|target audience|social media marketing|compet(?:e|es|ed|ing|itor|itors)|for example|such as|may use|could use|might use|industry participant)\b/i;

function relationshipFor(sentence, direction, seeded) {
  const value = sentence.toLowerCase();
  if (/\b(?:customer acquisition|search engine|social network|digital advertising)\b/.test(value)) return 'customer acquisition channel';
  if (/\b(?:cloud|hosting|data center|infrastructure)\b/.test(value)) return 'cloud provider';
  if (/\b(?:semiconductor|chip|gpu|processor)\b/.test(value)) return /manufactur|fabricat/.test(value) ? 'chip manufacturer' : 'chip supplier';
  if (/\b(?:payment|card network|transaction processing)\b/.test(value)) return 'payment processor';
  if (/\b(?:manufactur|assembly|fabricat|production partner)\b/.test(value)) return 'manufacturing partner';
  if (/\b(?:data provider|market data|licensed data|dataset)\b/.test(value)) return 'data provider';
  if (/\b(?:app store|distribut(?:ion|or|ors)|marketplace|reseller|fulfillment)\b/.test(value)) return 'distribution platform';
  if (/\b(?:revenue|sales|largest customer|major customer|key customer)\b/.test(value)) return direction === 'outbound' ? 'key customer' : 'customer';
  return seeded || (direction === 'inbound' ? 'customer' : 'material provider');
}
function classifyEvidence(sentence, alias, entry) {
  const text = cleanText(sentence);
  if (!MATERIAL_SIGNAL.test(text) || NON_DEPENDENCY.test(text)) return null;
  const escaped = escapeRegExp(alias);
  const inbound = [
    new RegExp(`${escaped}.{0,100}(?:depends?|relies|relied) on (?:our|the company(?:'s)?)`, 'i'),
    new RegExp(`${escaped}.{0,100}(?:uses?|licenses?|deploys?) (?:our|the company(?:'s)?)`, 'i'),
    new RegExp(`(?:we|the company) (?:are|serve as).{0,80}(?:sole|exclusive|key|critical).{0,60}(?:to|for) ${escaped}`, 'i'),
  ].some(pattern => pattern.test(text));
  const concentration = new RegExp(`${escaped}.{0,160}(?:accounted for|represented|generated).{0,40}\\d+(?:\\.\\d+)?%.{0,80}(?:revenue|sales|purchases|cost)|(?:revenue|sales|purchases|cost).{0,120}${escaped}.{0,80}\\d+(?:\\.\\d+)?%`, 'i').test(text);
  const outbound = concentration || [
    new RegExp(`(?:we|our|the company).{0,100}(?:depends?|rely|relies|relied).{0,70}(?:on )?${escaped}`, 'i'),
    new RegExp(`${escaped}.{0,100}(?:provides?|supplies|hosts?|processes|manufactures|powers).{0,100}(?:our|us|the company)`, 'i'),
    new RegExp(`(?:we|our|the company).{0,100}(?:purchase|purchases|purchased|license|licenses|licensed).{0,70}(?:from )?${escaped}`, 'i'),
    new RegExp(`(?:key|major|largest|material) (?:customer|supplier|provider).{0,80}${escaped}|${escaped}.{0,80}(?:key|major|largest|material) (?:customer|supplier|provider)`, 'i'),
  ].some(pattern => pattern.test(text));
  if (!inbound && !outbound) return null;
  const direction = inbound && !outbound ? 'inbound' : 'outbound';
  const strong = /\b(?:depends?|rely|relies|relied|sole|exclusive|key|major|largest|material|accounted for)\b/i.test(text);
  return { direction, relationship: relationshipFor(text, direction, entry.providerRelationship), confidence: strong ? 0.92 : 0.86 };
}
function extractEdgesFromFiling(record, text, sourceUrl, registry = SEED_COMPANIES) {
  if (!/^https:\/\/(?:www\.)?sec\.gov\//i.test(sourceUrl || '')) return normalizeGraph();
  const entries = registry._prepared ? registry : mergeRegistry([...registry, ...SEED_COMPANIES]);
  const inbound = [], outbound = [];
  for (const sentence of sentences(text).filter(value => MATERIAL_SIGNAL.test(value) && !NON_DEPENDENCY.test(value))) {
    for (const entry of entries) {
      const alias = entry._aliasMatchers.find(item => item.pattern.test(sentence))?.value;
      if (!alias || normalizedName(entry.company) === normalizedName(record.legalName || record.name)) continue;
      const classification = classifyEvidence(sentence, alias, entry);
      if (!classification) continue;
      const edge = {
        company: entry.company, ticker: entry.ticker, relationship: classification.relationship,
        dependencyType: classification.direction === 'inbound' ? 'depends_on_ipo_company' : 'ipo_company_depends_on',
        rationale: cleanText(sentence).slice(0, 500), sourceUrl,
        sourceTitle: `${record.legalName || record.name} SEC filing`, confidence: classification.confidence,
        extractionMethod: PARSER_VERSION,
      };
      (classification.direction === 'inbound' ? inbound : outbound).push(edge);
    }
  }
  return normalizeGraph({ publicCompaniesDependingOnIPO: inbound, publicCompaniesIPOCompanyDependsOn: outbound });
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mergers.news IPO dependencies contact@mergers.news', Accept: 'text/html,application/json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume(); return resolve(request(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 10_000_000) req.destroy(new Error('response size limit exceeded')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(25000, () => req.destroy(new Error('request timeout'))); req.on('error', reject);
  });
}
async function requestWithRetry(url, attempts = 3) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await request(url); } catch (value) { error = value; if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt))); }
  }
  throw error;
}
function cachePath(url) { return path.join(CACHE_DIR, `${crypto.createHash('sha256').update(url).digest('hex')}.html`); }
async function cachedText(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(url);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const body = await requestWithRetry(url); fs.writeFileSync(file, body); return body;
}
async function loadRegistry() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let payload;
  const fresh = fs.existsSync(REGISTRY_FILE) && Date.now() - fs.statSync(REGISTRY_FILE).mtimeMs < 30 * 86400000;
  try {
    payload = fresh ? JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) : JSON.parse(await requestWithRetry(REGISTRY_URL));
    if (!fresh) fs.writeFileSync(REGISTRY_FILE, JSON.stringify(payload));
  } catch (_) { payload = fs.existsSync(REGISTRY_FILE) ? JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) : null; }
  return mergeRegistry([...registryFromSec(payload), ...SEED_COMPANIES]);
}
function secUrls(record) {
  return [...new Set([record.sourceUrl, ...(record.sources || []).map(source => source.url)]
    .filter(url => /^https:\/\/(?:www\.)?sec\.gov\/Archives\//i.test(String(url || ''))))];
}
function graphWithoutGenerated(graph) {
  const normalized = normalizeGraph(graph);
  for (const key of ['publicCompaniesDependingOnIPO', 'publicCompaniesIPOCompanyDependsOn']) {
    normalized[key] = normalized[key].filter(edge => !GENERATED_METHODS.has(edge.extractionMethod));
  }
  return normalized;
}
function edgeCount(graph) { return graph.publicCompaniesDependingOnIPO.length + graph.publicCompaniesIPOCompanyDependsOn.length; }
function mergeGraphs(...graphs) {
  return normalizeGraph({
    publicCompaniesDependingOnIPO: graphs.flatMap(graph => graph.publicCompaniesDependingOnIPO || []),
    publicCompaniesIPOCompanyDependsOn: graphs.flatMap(graph => graph.publicCompaniesIPOCompanyDependsOn || []),
  });
}
function needsAttempt(record, refreshDays, force) {
  if (force || !record.dependencyIngestion?.attemptedAt) return true;
  return Date.now() - new Date(record.dependencyIngestion.attemptedAt).getTime() >= refreshDays * 86400000;
}
async function main() {
  const records = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const limit = Math.max(1, Number(process.env.DEPENDENCY_FETCH_LIMIT || 250));
  const urlsPerRecord = Math.max(1, Number(process.env.DEPENDENCY_URLS_PER_RECORD || 2));
  const refreshDays = Math.max(1, Number(process.env.DEPENDENCY_REFRESH_DAYS || 90));
  const force = process.env.DEPENDENCY_FORCE === 'true';
  const registry = await loadRegistry();
  const queue = records.filter(record => needsAttempt(record, refreshDays, force)).sort((a, b) =>
    Number(isActive(b)) - Number(isActive(a)) || (force ? 0 : String(a.dependencyIngestion?.attemptedAt || '').localeCompare(String(b.dependencyIngestion?.attemptedAt || ''))) || String(b.latestUpdateDate || '').localeCompare(String(a.latestUpdateDate || '')));
  let processed = 0, fetched = 0, cacheHits = 0, verifiedEdges = 0, failures = 0, noSource = 0;
  for (const record of queue.slice(0, limit)) {
    const urls = secUrls(record).slice(0, urlsPerRecord);
    const preserved = graphWithoutGenerated(record.dependencyGraph);
    const extracted = []; const errors = [];
    if (!urls.length) noSource++;
    for (const url of urls) {
      try {
        const wasCached = fs.existsSync(cachePath(url));
        const graph = extractEdgesFromFiling(record, await cachedText(url), url, registry);
        extracted.push(graph); fetched += Number(!wasCached); cacheHits += Number(wasCached);
        if (!wasCached) await new Promise(resolve => setTimeout(resolve, Number(process.env.DEPENDENCY_POLITENESS_MS || 150)));
      } catch (error) { errors.push(`${url}: ${error.message}`); failures++; }
    }
    record.dependencyGraph = mergeGraphs(preserved, ...extracted);
    verifiedEdges += edgeCount(record.dependencyGraph) - edgeCount(preserved);
    record.dependencyIngestion = {
      parserVersion: PARSER_VERSION, attemptedAt: new Date().toISOString(),
      status: !urls.length ? 'no_sec_source' : errors.length === urls.length ? 'fetch_failed' : edgeCount(record.dependencyGraph) > edgeCount(preserved) ? 'complete' : errors.length ? 'partial_error' : 'no_evidence',
      sourceUrlsFound: urls.length, sourceUrlsAttempted: urls.length, edgesFound: Math.max(0, edgeCount(record.dependencyGraph) - edgeCount(preserved)),
      errors: errors.slice(0, 3),
    };
    processed++;
    if (processed % 25 === 0) fs.writeFileSync(FILE, `${JSON.stringify(records, null, 2)}\n`);
  }
  fs.writeFileSync(FILE, `${JSON.stringify(records, null, 2)}\n`);
  console.log(JSON.stringify({ records: records.length, eligible: queue.length, processed, fetched, cacheHits, noSource, failures, verifiedEdges, registryCompanies: registry.length, parserVersion: PARSER_VERSION, output: FILE }));
}

module.exports = { PARSER_VERSION, SEED_COMPANIES, stripHtml, sentences, registryFromSec, mergeRegistry, classifyEvidence, extractEdgesFromFiling, secUrls, graphWithoutGenerated, needsAttempt };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
