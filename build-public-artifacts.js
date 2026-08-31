'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalPrimarySourceUrl } = require('./FIX-source-url');

const NON_MA_TYPES = new Set(['Funding Round', 'Strategic Investment']);
const NON_MA_HEADLINE = /\bto (?:release|launch|unveil|introduce|present|ship|report)\b|\bearnings?\b|\bquarterly results?\b|\bannual results?\b|\bproduct launch\b|\bIPO priced\b|\bappoints?\s+(?:new\s+)?(?:ceo|cfo|coo|cto|president|chairman|vp)\b|\bnames?\s+(?:new\s+)?(?:ceo|cfo|coo|cto|president|chairman)\b|\braises?\s+\$\d|\bseries [a-e]\s+(?:funding|round|investment)\b|\bjoint venture\b|\bpartnership agreement\b|\bdistribution agreement\b|\blicen(?:se|sing) agreement\b/i;
const SAFE_STATUSES = new Map([
  ['announced','Announced'],['pending','Pending'],['completed','Completed'],['terminated','Terminated'],
  ['withdrawn','Withdrawn'],['rumored','Rumored'],['unknown','Unknown']
]);

function isPublicTransaction(deal) {
  if (!deal || typeof deal !== 'object' || typeof deal.headline !== 'string') return false;
  if (deal.dealType && NON_MA_TYPES.has(deal.dealType)) return false;
  if (NON_MA_HEADLINE.test(deal.headline)) return false;
  if (!deal.acquirer && !deal.target && !deal.extractedAcquirer && !deal.extractedTarget) return false;
  return true;
}

function normalizeStatus(value) {
  return SAFE_STATUSES.get(String(value || 'unknown').toLowerCase()) || 'Unknown';
}

function canonicalizeDeal(input) {
  const deal = { ...input };
  deal.status = normalizeStatus(deal.status);
  deal.sourceUrl = canonicalPrimarySourceUrl(deal);
  if (String(deal.sourceType || deal.extractionMethod || '').toLowerCase().includes('sec')) {
    deal.edgarUrl = deal.sourceUrl;
  }
  return deal;
}

function compactDeal(d) {
  const keys = [
    'id','headline','acquirer','target','extractedAcquirer','extractedTarget','dealType','status',
    'dealValue','dealValueNum','perShare','premium','sector','region','country','date','year','dateISO',
    'closingDate','timeAgo','era','isPrivateEquity','isHostile','source','sourceUrl','filingType','edgarUrl',
    'extractionMethod','sourceType','sourceName','accessionNo','confidence','breaking'
  ];
  const out = {};
  for (const key of keys) if (d[key] !== undefined && d[key] !== null && d[key] !== '') out[key] = d[key];
  return out;
}

function buildArtifacts(inputDeals) {
  const deals = inputDeals.filter(isPublicTransaction).map(canonicalizeDeal);
  const index = deals.map(compactDeal);
  const shards = new Map();
  for (const deal of deals) {
    const year = String(deal.year || String(deal.dateISO || '').slice(0,4) || 'unknown');
    const key = /^\d{4}$/.test(year) ? year : 'unknown';
    if (!shards.has(key)) shards.set(key, []);
    shards.get(key).push(deal);
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    dealCount: deals.length,
    indexFile: 'deals-index.json',
    detailBase: 'deals-details/',
    detailShards: [...shards.entries()].map(([year, rows]) => ({ year, count: rows.length, file: `deals-details/${year}.json` })),
  };
  return { deals, index, shards, manifest };
}

function writeArtifacts(inputDeals, root = '.') {
  const { index, shards, manifest } = buildArtifacts(inputDeals);
  fs.writeFileSync(path.join(root, 'deals-index.json'), JSON.stringify(index) + '\n');
  fs.writeFileSync(path.join(root, 'deals-public-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const detailDir = path.join(root, 'deals-details');
  fs.rmSync(detailDir, { recursive: true, force: true });
  fs.mkdirSync(detailDir, { recursive: true });
  for (const [year, rows] of shards) fs.writeFileSync(path.join(detailDir, `${year}.json`), JSON.stringify(rows) + '\n');
  return manifest;
}

if (require.main === module) {
  const deals = JSON.parse(fs.readFileSync(process.argv[2] || 'deals.json', 'utf8'));
  const manifest = writeArtifacts(deals, process.cwd());
  console.log(`[PUBLIC] ${manifest.dealCount} deals -> ${manifest.detailShards.length} detail shards`);
}

module.exports = { isPublicTransaction, normalizeStatus, canonicalizeDeal, compactDeal, buildArtifacts, writeArtifacts };
