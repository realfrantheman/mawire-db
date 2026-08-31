'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalPrimarySourceUrl } = require('./FIX-source-url');

const RULE = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const PLACEHOLDER = /^(?:unknown|undisclosed|n\/?a|null|none|tbd|not disclosed|see filing|disclosed in filing)/i;
const ALLOWED_TYPES = new Set([
  'Acquisition',
  'Merger / Business Combination',
  'Tender Offer',
  'LBO / Going-Private',
  'Divestiture / Carve-Out',
]);

function normalizedParty(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPublicTransaction(deal) {
  if (!deal || deal.reviewStatus !== 'verified' || deal.reviewRuleVersion !== RULE) return false;
  if (!ALLOWED_TYPES.has(deal.dealType)) return false;
  if (!deal.acquirer || !deal.target || PLACEHOLDER.test(deal.acquirer) || PLACEHOLDER.test(deal.target)) return false;
  if (normalizedParty(deal.acquirer) === normalizedParty(deal.target)) return false;
  return /^https?:\/\//i.test(canonicalPrimarySourceUrl(deal) || '');
}

function compactDeal(deal) {
  const keys = [
    'id','headline','acquirer','target','dealType','status','dealValue','dealValueNum','perShare','premium',
    'sector','region','country','date','year','dateISO','closingDate','timeAgo','era','isPrivateEquity','isHostile',
    'source','sourceUrl','filingType','edgarUrl','extractionMethod','sourceType','sourceName','accessionNo','confidence',
    'breaking','reviewStatus','reviewRuleVersion','reviewedAt'
  ];
  const out = {};
  for (const key of keys) if (deal[key] !== undefined && deal[key] !== null && deal[key] !== '') out[key] = deal[key];
  return out;
}

function buildArtifacts(inputDeals) {
  const deals = inputDeals
    .filter(isPublicTransaction)
    .map(deal => ({ ...deal, sourceUrl: canonicalPrimarySourceUrl(deal) }));
  const index = deals.map(compactDeal);
  const shards = new Map();
  const typeCounts = {};
  for (const deal of deals) {
    const year = String(deal.year || String(deal.dateISO || '').slice(0, 4) || 'unknown');
    const shard = /^\d{4}$/.test(year) ? year : 'unknown';
    if (!shards.has(shard)) shards.set(shard, []);
    shards.get(shard).push(deal);
    typeCounts[deal.dealType] = (typeCounts[deal.dealType] || 0) + 1;
  }
  return {
    deals,
    index,
    shards,
    manifest: {
      generatedAt: new Date().toISOString(),
      ruleVersion: RULE,
      sourceRecordCount: inputDeals.length,
      dealCount: deals.length,
      typeCounts,
      allowedTypes: [...ALLOWED_TYPES],
      publicationRule: 'Verified primary-source control transactions only.',
    },
  };
}

function writeArtifacts(inputDeals, root = '.') {
  const result = buildArtifacts(inputDeals);
  fs.writeFileSync(path.join(root, 'deals-index.json'), JSON.stringify(result.index) + '\n');
  fs.writeFileSync(path.join(root, 'deals-public-manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  const detailDir = path.join(root, 'deals-details');
  fs.rmSync(detailDir, { recursive: true, force: true });
  fs.mkdirSync(detailDir, { recursive: true });
  for (const [year, rows] of result.shards) {
    fs.writeFileSync(path.join(detailDir, `${year}.json`), JSON.stringify(rows) + '\n');
  }
  return result.manifest;
}

if (require.main === module) {
  const input = JSON.parse(fs.readFileSync(process.argv[2] || 'deals.json', 'utf8'));
  const manifest = writeArtifacts(input, process.cwd());
  console.log('[PUBLIC]', manifest.dealCount, 'verified deals');
}

module.exports = { RULE, ALLOWED_TYPES, normalizedParty, isPublicTransaction, compactDeal, buildArtifacts, writeArtifacts };
