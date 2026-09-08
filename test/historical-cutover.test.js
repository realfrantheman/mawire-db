'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const publicData = require('../build-public-artifacts');

function strict(overrides = {}) {
  return {
    id: 'strict-1',
    headline: 'Buyer Corp / Target Inc.',
    acquirer: 'Buyer Corp',
    target: 'Target Inc.',
    dealType: 'Acquisition',
    reviewStatus: 'verified',
    reviewRuleVersion: publicData.RULE,
    sourceType: 'company_press_release',
    sourceUrl: 'https://example.com/deal',
    dateISO: '2026-09-07',
    year: 2026,
    ...overrides,
  };
}

const legacy = {
  id: 'legacy-1',
  headline: 'Old Buyer / Old Target',
  acquirer: 'Old Buyer',
  target: 'Old Target',
  dealType: 'Acquisition',
  sourceUrl: 'https://example.com/legacy',
  dateISO: '2020-01-01',
  year: 2020,
};

test('partial migration preserves historical public rows', () => {
  const result = publicData.buildArtifacts([strict()], { legacyIndex: [legacy], preserveLegacy: true });
  assert.equal(result.index.length, 2);
  assert.equal(result.manifest.legacyRecordCount, 1);
  assert.equal(result.manifest.historicalCutoverApplied, false);
});

test('approved cutover removes unreviewed legacy rows and publishes verified rows only', () => {
  const result = publicData.buildArtifacts([strict(), { ...legacy, reviewStatus: 'rejected', reviewRuleVersion: publicData.RULE }], {
    legacyIndex: [legacy],
    preserveLegacy: false,
  });
  assert.equal(result.index.length, 1);
  assert.equal(result.index[0].id, 'strict-1');
  assert.equal(result.manifest.legacyRecordCount, 0);
  assert.equal(result.manifest.historicalCutoverApplied, true);
});

test('cutover manifest must be complete, 100% covered, current-rule and above verified floor', () => {
  const base = {
    cutoverApplied: true,
    complete: true,
    coveragePct: 100,
    ruleVersion: publicData.RULE,
    publicVerifiedCount: 12000,
    safetyThresholds: { minVerified: 10000 },
  };
  assert.equal(publicData.isApprovedHistoricalCutover(base), true);
  assert.equal(publicData.isApprovedHistoricalCutover({ ...base, complete: false }), false);
  assert.equal(publicData.isApprovedHistoricalCutover({ ...base, coveragePct: 99.99 }), false);
  assert.equal(publicData.isApprovedHistoricalCutover({ ...base, ruleVersion: 'old-rule' }), false);
  assert.equal(publicData.isApprovedHistoricalCutover({ ...base, publicVerifiedCount: 9999 }), false);
});
