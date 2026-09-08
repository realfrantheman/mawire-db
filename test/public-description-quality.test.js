'use strict';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withPublicDescription } = require('../FIX-public-description');
const { isSaneParty, applyStrictOverrides, buildArtifacts } = require('../build-public-artifacts');
const review = require('../FIX-transaction-review');

test('public descriptions contain transaction facts, not internal review language', () => {
  const deal = withPublicDescription({
    acquirer: 'Intercontinental Exchange, Inc.',
    target: 'MarketAxess Holdings Inc.',
    dealType: 'Merger / Business Combination',
    filingType: 'PREM14A',
    date: 'Sep 4, 2026',
  });
  assert.match(deal.summary, /Intercontinental Exchange/);
  assert.match(deal.summary, /MarketAxess/);
  assert.match(deal.body, /SEC Form PREM14A/);
  assert.doesNotMatch(`${deal.summary} ${deal.body}`, /strict-control|review rule|passed the/i);
});

test('publication party gate rejects sentence fragments and regulators', () => {
  for (const value of [
    'respect to the Merger',
    'Team, Today, we announced',
    'Starman means',
    'the Federal Trade Commission',
  ]) assert.equal(isSaneParty(value), false, value);
  assert.equal(isSaneParty('Intercontinental Exchange, Inc.'), true);
  assert.equal(isSaneParty('Action Acquisitions LLC'), true);
});

test('strict overrides replace known bad parties before publication', () => {
  const input = [{
    id: 'sec-x',
    headline: 'the Federal Trade Commission / MARKETAXESS HOLDINGS INC',
    acquirer: 'the Federal Trade Commission',
    target: 'MARKETAXESS HOLDINGS INC',
    dealType: 'Merger / Business Combination',
    reviewStatus: 'verified',
    reviewRuleVersion: 'strict-control-v3',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/a.htm',
    filingType: 'PREM14A',
    dateISO: '2026-09-04',
    year: 2026,
  }];
  const overrides = { 'sec-x': { acquirer: 'Intercontinental Exchange, Inc.', target: 'MarketAxess Holdings Inc.' } };
  const rows = applyStrictOverrides(input, overrides);
  assert.equal(rows[0].acquirer, 'Intercontinental Exchange, Inc.');
  const built = buildArtifacts(input, { preserveLegacy: false, overrides });
  assert.equal(built.index.length, 1);
  assert.equal(built.index[0].acquirer, 'Intercontinental Exchange, Inc.');
  assert.match(built.deals[0].summary, /Intercontinental Exchange/);
});

test('ambiguous override can quarantine a previously verified row', () => {
  const input = [{
    id: 'sec-y', acquirer: 'Buyer Corp', target: 'Target Inc.', headline: 'Buyer Corp / Target Inc.',
    dealType: 'Acquisition', reviewStatus: 'verified', reviewRuleVersion: 'strict-control-v3',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/b.htm', dateISO: '2026-09-04', year: 2026,
  }];
  const built = buildArtifacts(input, { preserveLegacy: false, overrides: { 'sec-y': { reviewStatus: 'needs_review' } } });
  assert.equal(built.index.length, 0);
});

test('role-aware SEC verification rejects plausible but unrelated regulator names', () => {
  const result = review.reviewEvidence({
    headline: 'Federal Trade Commission / MarketAxess Holdings Inc.',
    acquirer: 'Federal Trade Commission',
    target: 'MarketAxess Holdings Inc.',
    filingType: 'PREM14A',
    sourceType: 'sec_edgar',
  }, 'MarketAxess Holdings Inc. entered into an Agreement and Plan of Merger with Intercontinental Exchange, Inc. The Federal Trade Commission was notified under the HSR Act.');
  assert.equal(result.status, 'rejected');
});

test('role-aware SEC verification keeps a valid defined parent merger', () => {
  const result = review.reviewEvidence({
    headline: 'Buyer Corp / Target Inc.',
    acquirer: 'Buyer Corp',
    target: 'Target Inc.',
    filingType: 'DEFM14A',
    sourceType: 'sec_edgar',
  }, 'Target Inc. entered into an Agreement and Plan of Merger with Buyer Corp ("Parent"). Under the Merger Agreement, Target Inc. will be acquired by Buyer Corp.');
  assert.equal(result.status, 'verified');
  assert.equal(result.transactionType, 'Merger / Business Combination');
});

test('SEC verification does not promote a roleless company merely because its name appears', () => {
  const result = review.reviewEvidence({
    headline: 'Advisor Partners LLC / Target Inc.',
    acquirer: 'Advisor Partners LLC',
    target: 'Target Inc.',
    filingType: 'DEFM14A',
    sourceType: 'sec_edgar',
  }, 'Target Inc. entered into an Agreement and Plan of Merger with Buyer Corp. Advisor Partners LLC delivered a fairness opinion to the board.');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reasonCode, 'sec_party_roles_not_proven');
});
