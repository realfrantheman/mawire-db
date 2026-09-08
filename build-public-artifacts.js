'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalPrimarySourceUrl } = require('./FIX-source-url');
const { withPublicDescription } = require('./FIX-public-description');

const RULE = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const PLACEHOLDER = /^(?:unknown|undisclosed|n\/?a|null|none|tbd|not disclosed|see filing|disclosed in filing)/i;
const PARTY_BOILERPLATE = /\b(?:secretary of state|surviving company|as applicable|as a result of|does not close|additionally|making such other filings|such other filings|pursuant to the foregoing|in connection with the foregoing|described above|set forth herein|filed with the state|the state of delaware)\b/i;
const PARTY_PROSE = /\b(?:with respect to|respect to the|team,? today|we announced|we have announced|starman means|means and includes|this transaction|the merger|the proposed merger|proxy statement|special meeting|shareholders? are|board of directors)\b/i;
const REGULATOR_PARTY = /^(?:the\s+)?(?:federal trade commission|securities and exchange commission|u\.?s\.? department of justice|department of justice|competition and markets authority|european commission)$/i;
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

function isSaneParty(value) {
  const raw = String(value || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 100 || PLACEHOLDER.test(raw) || PARTY_BOILERPLATE.test(raw) || PARTY_PROSE.test(raw) || REGULATOR_PARTY.test(raw)) return false;
  const words = normalizedParty(raw).split(' ').filter(Boolean);
  if (!words.length || words.length > 10) return false;
  return /[A-Za-z]{2}/.test(raw);
}

function isPublicTransaction(deal) {
  if (!deal || deal.reviewStatus !== 'verified' || deal.reviewRuleVersion !== RULE) return false;
  if (!ALLOWED_TYPES.has(deal.dealType)) return false;
  if (!isSaneParty(deal.acquirer) || !isSaneParty(deal.target)) return false;
  if (normalizedParty(deal.acquirer) === normalizedParty(deal.target)) return false;
  return /^https?:\/\//i.test(canonicalPrimarySourceUrl(deal) || '');
}

function compactDeal(deal) {
  const keys = [
    'id','headline','acquirer','target','dealType','status','dealValue','dealValueNum','perShare','premium',
    'sector','region','country','date','year','dateISO','closingDate','timeAgo','era','isPrivateEquity','isHostile',
    'source','sourceUrl','filingType','edgarUrl','extractionMethod','sourceType','sourceName','accessionNo','confidence',
    'breaking','reviewStatus','reviewRuleVersion','reviewEngineVersion','reviewedAt'
  ];
  const out = {};
  for (const key of keys) if (deal[key] !== undefined && deal[key] !== null && deal[key] !== '') out[key] = deal[key];
  return out;
}

function sourceIdentity(deal) {
  return String(deal?.sourceUrl || deal?.edgarUrl || '').replace(/[?#].*$/, '').toLowerCase();
}

function isLegacyIndexRow(row) {
  return !!row && !row.reviewStatus && !row.reviewRuleVersion;
}

function normalizeOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function applyStrictOverrides(inputDeals, overrides = {}) {
  const map = normalizeOverrides(overrides);
  return (inputDeals || []).map(deal => {
    const override = map[String(deal?.id || '')];
    return override && typeof override === 'object' ? { ...deal, ...override } : deal;
  });
}

function readStrictOverrides(root) {
  try {
    return normalizeOverrides(JSON.parse(fs.readFileSync(path.join(root, 'strict-record-overrides.json'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function buildArtifacts(inputDeals, options = {}) {
  const existingIndex = Array.isArray(options.legacyIndex) ? options.legacyIndex : [];
  const preserveLegacy = options.preserveLegacy !== false;
  const overrides = normalizeOverrides(options.overrides);
  const reviewedInput = applyStrictOverrides(inputDeals, overrides);
  const legacyIndex = preserveLegacy ? existingIndex.filter(isLegacyIndexRow) : [];
  const byId = new Map(reviewedInput.map(deal => [String(deal.id), deal]));

  const strictDeals = reviewedInput
    .filter(isPublicTransaction)
    .map(deal => withPublicDescription({ ...deal, sourceUrl: canonicalPrimarySourceUrl(deal) }))
    .sort((a, b) => String(b.dateISO || '').localeCompare(String(a.dateISO || '')) || String(a.id).localeCompare(String(b.id)));
  const strictIndex = strictDeals.map(compactDeal);
  const strictIds = new Set(strictIndex.map(row => String(row.id)));
  const strictSources = new Set(strictIndex.map(sourceIdentity).filter(Boolean));

  const retainedLegacyIndex = legacyIndex.filter(row => {
    if (strictIds.has(String(row.id))) return false;
    const source = sourceIdentity(row);
    return !source || !strictSources.has(source);
  });
  const legacyDeals = retainedLegacyIndex.map(row => byId.get(String(row.id)) || row);
  const deals = [...strictDeals, ...legacyDeals];
  const index = [...strictIndex, ...retainedLegacyIndex];

  const shards = new Map();
  const typeCounts = {};
  for (const deal of deals) {
    const year = String(deal.year || String(deal.dateISO || '').slice(0, 4) || 'unknown');
    const shard = /^\d{4}$/.test(year) ? year : 'unknown';
    if (!shards.has(shard)) shards.set(shard, []);
    shards.get(shard).push(deal);
    typeCounts[deal.dealType || 'Unknown'] = (typeCounts[deal.dealType || 'Unknown'] || 0) + 1;
  }
  return {
    deals,
    index,
    shards,
    manifest: {
      generatedAt: new Date().toISOString(),
      ruleVersion: RULE,
      sourceRecordCount: inputDeals.length,
      dealCount: index.length,
      legacyRecordCount: retainedLegacyIndex.length,
      strictVerifiedCount: strictIndex.length,
      strictOverrideCount: Object.keys(overrides).length,
      historicalCutoverApplied: !preserveLegacy,
      typeCounts,
      allowedTypes: [...ALLOWED_TYPES],
      publicationRule: preserveLegacy
        ? 'Historical review migration in progress: preserve the existing public corpus while all new admissions require strict primary-source verification.'
        : 'Historical review migration complete: publish only strict verified control transactions.',
    },
  };
}

function readExistingIndex(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'deals-index.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function readLegacyReviewManifest(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'legacy-review-manifest.json'), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function isApprovedHistoricalCutover(manifest) {
  if (!manifest || manifest.cutoverApplied !== true || manifest.complete !== true) return false;
  if (manifest.ruleVersion !== RULE || Number(manifest.coveragePct) !== 100) return false;
  const minimum = Number(manifest.safetyThresholds?.minVerified || 0);
  return Number(manifest.publicVerifiedCount || 0) >= minimum && minimum > 0;
}

function writeArtifacts(inputDeals, root = '.') {
  const legacyIndex = readExistingIndex(root);
  const reviewManifest = readLegacyReviewManifest(root);
  const overrides = readStrictOverrides(root);
  const preserveLegacy = !isApprovedHistoricalCutover(reviewManifest);
  const result = buildArtifacts(inputDeals, { legacyIndex, preserveLegacy, overrides });
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
  console.log('[PUBLIC]', `${manifest.dealCount} deals`, `(${manifest.legacyRecordCount} legacy, ${manifest.strictVerifiedCount} strict)`);
}

module.exports = {
  RULE, ALLOWED_TYPES, normalizedParty, isSaneParty, isPublicTransaction, compactDeal,
  isLegacyIndexRow, normalizeOverrides, applyStrictOverrides, readStrictOverrides, buildArtifacts,
  readLegacyReviewManifest, isApprovedHistoricalCutover, writeArtifacts,
};
