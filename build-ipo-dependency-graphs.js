#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');
const { normalizeGraph } = require('./ipo-data');

const FILE = process.env.IPO_OUTPUT || 'ipos.json';
const PUBLIC_COMPANIES = [
  { company: 'Amazon', ticker: 'AMZN', aliases: ['Amazon Web Services', 'AWS'], providerRelationship: 'cloud provider' },
  { company: 'Microsoft', ticker: 'MSFT', aliases: ['Microsoft Azure', 'Azure'], providerRelationship: 'cloud provider' },
  { company: 'Alphabet', ticker: 'GOOGL', aliases: ['Google Cloud', 'Google'], providerRelationship: 'cloud provider' },
  { company: 'NVIDIA', ticker: 'NVDA', aliases: ['NVIDIA', 'Nvidia'], providerRelationship: 'chip supplier' },
  { company: 'Apple', ticker: 'AAPL', aliases: ['Apple App Store', 'Apple'], providerRelationship: 'customer acquisition channel' },
  { company: 'Meta Platforms', ticker: 'META', aliases: ['Meta Platforms', 'Facebook'], providerRelationship: 'customer acquisition channel' },
  { company: 'Visa', ticker: 'V', aliases: ['Visa'], providerRelationship: 'payment processor' },
  { company: 'Mastercard', ticker: 'MA', aliases: ['Mastercard'], providerRelationship: 'payment processor' },
  { company: 'Shopify', ticker: 'SHOP', aliases: ['Shopify'], providerRelationship: 'distribution partner' },
];

function stripHtml(html) {
  return String(html || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function sentences(text) { return stripHtml(text).match(/[^.!?]{20,500}[.!?]/g) || []; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function extractEdgesFromFiling(record, text, sourceUrl) {
  if (!/^https?:\/\//i.test(sourceUrl || '')) return { publicCompaniesDependingOnIPO: [], publicCompaniesIPOCompanyDependsOn: [] };
  const outbound = [];
  const dependencyLanguage = /\b(?:depend(?:s|ed)? on|rely|relies|relied on|key (?:customer|supplier|provider)|material (?:customer|supplier|provider)|provided by|supplier|processor|hosted by|powered by|purchase(?:s|d)? from|contract(?:ed)? with|agreement with)\b/i;
  const nonDependencyLanguage = /\b(?:plan(?:s|ned)? to|intend(?:s|ed)? to|marketing|promotional|advertis(?:e|ing)|target audience|social media marketing)\b/i;
  for (const company of PUBLIC_COMPANIES) {
    const aliasPattern = new RegExp(`\\b(?:${company.aliases.map(escapeRegExp).join('|')})\\b`, 'i');
    const evidence = sentences(text).find(sentence => aliasPattern.test(sentence) && dependencyLanguage.test(sentence) && !nonDependencyLanguage.test(sentence));
    if (!evidence) continue;
    outbound.push({
      company: company.company, ticker: company.ticker, relationship: company.providerRelationship,
      dependencyType: 'ipo_company_depends_on', rationale: evidence.trim().slice(0, 360),
      sourceUrl, sourceTitle: `${record.legalName || record.name} SEC filing`, confidence: 0.92,
      extractionMethod: 'deterministic-sec-dependency-v1',
    });
  }
  return normalizeGraph({ publicCompaniesDependingOnIPO: [], publicCompaniesIPOCompanyDependsOn: outbound });
}
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mergers.news IPO dependencies contact@mergers.news' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8_000_000) req.destroy(new Error('size limit')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
async function main() {
  const records = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const shouldFetch = process.env.DEPENDENCY_FETCH === 'true';
  const limit = Number(process.env.DEPENDENCY_FETCH_LIMIT || 25);
  let fetched = 0, edges = 0;
  for (const record of records) {
    record.dependencyGraph = normalizeGraph(record.dependencyGraph);
    if (process.env.DEPENDENCY_REBUILD === 'true') {
      for (const key of ['publicCompaniesDependingOnIPO', 'publicCompaniesIPOCompanyDependsOn']) {
        record.dependencyGraph[key] = record.dependencyGraph[key].filter(edge =>
          edge.extractionMethod !== 'deterministic-sec-dependency-v1' &&
          !(edge.confidence === 0.92 && / SEC filing$/.test(edge.sourceTitle || '')));
      }
    }
    if (!shouldFetch || fetched >= limit || !/sec\.gov/i.test(record.sourceUrl || '')) continue;
    if (record.dependencyGraph.publicCompaniesDependingOnIPO.length || record.dependencyGraph.publicCompaniesIPOCompanyDependsOn.length) continue;
    try {
      const graph = extractEdgesFromFiling(record, await fetchText(record.sourceUrl), record.sourceUrl);
      record.dependencyGraph = graph;
      edges += graph.publicCompaniesIPOCompanyDependsOn.length + graph.publicCompaniesDependingOnIPO.length;
    } catch { /* no evidence is safer than an inferred edge */ }
    fetched++;
  }
  fs.writeFileSync(FILE, `${JSON.stringify(records, null, 2)}\n`);
  console.log(JSON.stringify({ records: records.length, filingsFetched: fetched, verifiedEdges: edges, output: FILE }));
}

module.exports = { PUBLIC_COMPANIES, stripHtml, extractEdgesFromFiling };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
