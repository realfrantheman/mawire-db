'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('../review-legacy-corpus');

function verified(type = 'Acquisition') {
  return {
    status: 'verified',
    reasonCode: 'verified_primary_source_control_transaction',
    transactionType: type,
    evidenceExcerpt: 'evidence',
  };
}

function record(headline = 'Buyer Corp agrees to acquire Target Inc.') {
  return { headline, acquirer: 'Buyer Corp', target: 'Target Inc.' };
}

test('historical guard rejects explicit minority acquisition even when generic acquisition language is present', () => {
  const source = 'Buyer Corp announced the acquisition of a 20% minority stake in Target Inc.';
  const result = legacy.enforceHistoricalControlGuard(record(), source, verified());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'legacy_explicit_non_control_transaction');
});

test('historical guard rejects numeric non-control stake purchases', () => {
  const source = 'Buyer Corp agreed to acquire a 35% equity stake in Target Inc.';
  const result = legacy.enforceHistoricalControlGuard(record(), source, verified());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'legacy_non_control_percentage_stake');
});

test('historical guard permits majority-control acquisition', () => {
  const source = 'Buyer Corp agreed to acquire a 51% majority stake in Target Inc., giving Buyer Corp control of Target Inc.';
  const result = legacy.enforceHistoricalControlGuard(record(), source, verified());
  assert.equal(result.status, 'verified');
});

test('historical guard permits acquisition of remaining shares to full control', () => {
  const source = 'Buyer Corp, which owns 20% today, agreed to acquire all remaining shares of Target Inc. and will own 100% at closing.';
  const result = legacy.enforceHistoricalControlGuard(record(), source, verified());
  assert.equal(result.status, 'verified');
});

test('historical guard rejects joint ventures and non-binding proposals', () => {
  const jointVenture = legacy.enforceHistoricalControlGuard(record(), 'Buyer Corp and Target Inc. announced a joint venture and acquisition of a 40% interest.', verified());
  assert.equal(jointVenture.status, 'rejected');
  const proposal = legacy.enforceHistoricalControlGuard(record(), 'Buyer Corp submitted a non-binding proposal to acquire Target Inc.', verified());
  assert.equal(proposal.status, 'rejected');
});

test('strong merger evidence is not invalidated by unrelated minority wording', () => {
  const source = 'Buyer Corp and Target Inc. entered into an agreement and plan of merger. The background section discusses a prior minority investment.';
  const result = legacy.enforceHistoricalControlGuard(record(), source, verified('Merger / Business Combination'));
  assert.equal(result.status, 'verified');
});

test('uncertain party failures become needs_review rather than historical deletion', () => {
  const result = legacy.normalizeUncertain({ status: 'rejected', reasonCode: 'party_not_confirmed_in_primary_source', transactionType: null }, false);
  assert.equal(result.status, 'needs_review');
});

test('truncated evidence cannot create a destructive rejection without explicit historical guard evidence', () => {
  const result = legacy.normalizeUncertain({ status: 'rejected', reasonCode: 'conditional_filing_without_mna_evidence', transactionType: null }, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reasonCode, 'source_truncated_before_verification');
});

test('cutover requires complete review and safety ratios', () => {
  const deals = Array.from({ length: 10000 }, (_, i) => ({ id: `d-${i}` }));
  const state = { records: {} };
  for (let i = 0; i < 9999; i++) {
    state.records[`id:d-${i}`] = {
      ruleVersion: legacy.RULE_VERSION,
      engineVersion: legacy.ENGINE_VERSION,
      status: 'verified',
      reasonCode: 'verified',
    };
  }
  const incomplete = legacy.summarize(deals, state);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.cutoverEligible, false);

  state.records['id:d-9999'] = {
    ruleVersion: legacy.RULE_VERSION,
    engineVersion: legacy.ENGINE_VERSION,
    status: 'verified',
    reasonCode: 'verified',
  };
  const complete = legacy.summarize(deals, state);
  assert.equal(complete.complete, true);
  assert.equal(complete.cutoverEligible, true);
});

test('duplicate record IDs block automatic cutover', () => {
  const deals = Array.from({ length: 10000 }, (_, i) => ({ id: i < 2 ? 'duplicate' : `d-${i}` }));
  const state = { records: {} };
  for (const deal of deals) {
    state.records[legacy.recordKey(deal)] = {
      ruleVersion: legacy.RULE_VERSION,
      engineVersion: legacy.ENGINE_VERSION,
      status: 'verified',
      reasonCode: 'verified',
    };
  }
  const summary = legacy.summarize(deals, state);
  assert.equal(summary.duplicateIds, 1);
  assert.equal(summary.cutoverEligible, false);
});
