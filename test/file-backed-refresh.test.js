'use strict';

process.env.TRANSACTION_REVIEW_RULE_VERSION = 'strict-control-v3';
process.env.FILE_REFRESH_MAX_ATTEMPTS = '5';
process.env.FILE_REFRESH_RETRY_HOURS = '6';

const test = require('node:test');
const assert = require('node:assert/strict');
const refresh = require('../refresh-file-backed');
const { isPublicTransaction } = require('../build-public-artifacts');

function fixture(overrides = {}) {
  const filing = {
    id: '0000123456-26-000001:merger.htm',
    accession_no: '0000123456-26-000001',
    cik: '123456',
    filing_date: '2026-09-02',
    entity_name: 'Target Inc.',
  };
  const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/merger.htm';
  const info = {
    headline: 'Buyer Corp / Target Inc.',
    extracted_acquirer_name: 'Buyer Corp',
    extracted_target_name: 'Target Inc.',
    deal_value_cents: 125000000000,
    sector: 'Technology',
    source_confidence: 0.9,
    filing_date: '2026-09-02',
    announcement_date: '2026-09-02',
  };
  const reviewResult = {
    status: 'verified',
    reasonCode: 'verified_primary_source_control_transaction',
    transactionType: 'Acquisition',
  };
  return { filing, filingType: 'DEFM14A', detail: { document_url: sourceUrl }, info, sourceUrl, reviewResult, reviewedAt: '2026-09-02T20:00:00.000Z', ...overrides };
}

test('verified SEC candidate becomes a publishable deterministic deal', () => {
  const input = fixture();
  const deal = refresh.candidateToDeal(input);
  assert.ok(deal);
  assert.equal(deal.id, 'sec-0000123456-26-000001');
  assert.equal(deal.dealType, 'Acquisition');
  assert.equal(deal.dealValue, '$1.3B');
  assert.equal(deal.reviewStatus, 'verified');
  assert.equal(deal.reviewRuleVersion, 'strict-control-v3');
  assert.equal(deal.sourceType, 'sec_edgar');
  assert.ok(isPublicTransaction(deal));
});

test('non-verified review result can never enter the public artifact', () => {
  const deal = refresh.candidateToDeal(fixture({ reviewResult: { status: 'needs_review', reasonCode: 'control_transaction_not_proven' } }));
  assert.equal(deal, null);
});

test('non-direct SEC source can never enter the public artifact', () => {
  const deal = refresh.candidateToDeal(fixture({ sourceUrl: 'https://www.sec.gov/edgar/search/' }));
  assert.equal(deal, null);
});

test('identity keys deduplicate by accession and exact transaction source', () => {
  const deal = refresh.candidateToDeal(fixture());
  const keys = refresh.identityKeys(deal);
  assert.ok(keys.includes('accession:0000123456-26-000001'));
  const existing = refresh.existingIdentitySet([deal]);
  assert.ok(keys.every(key => existing.has(key)));
});

test('rejected filing is suppressed until the review rule changes', () => {
  const accession = '0000123456-26-000001';
  const state = { filings: { [accession]: { status: 'rejected', attempts: 1, ruleVersion: 'strict-control-v3', lastAttemptAt: '2026-09-02T00:00:00.000Z' } } };
  assert.equal(refresh.shouldAttempt(accession, state, Date.parse('2026-09-03T00:00:00.000Z')), false);
  state.filings[accession].ruleVersion = 'strict-control-v2';
  assert.equal(refresh.shouldAttempt(accession, state, Date.parse('2026-09-03T00:00:00.000Z')), true);
});

test('retryable failures are throttled and bounded', () => {
  const accession = '0000123456-26-000001';
  const state = { filings: { [accession]: { status: 'error', attempts: 2, ruleVersion: 'strict-control-v3', lastAttemptAt: '2026-09-02T20:00:00.000Z' } } };
  assert.equal(refresh.shouldAttempt(accession, state, Date.parse('2026-09-02T23:00:00.000Z')), false);
  assert.equal(refresh.shouldAttempt(accession, state, Date.parse('2026-09-03T03:00:00.000Z')), true);
  state.filings[accession].attempts = 5;
  assert.equal(refresh.shouldAttempt(accession, state, Date.parse('2026-09-03T12:00:00.000Z')), false);
});
