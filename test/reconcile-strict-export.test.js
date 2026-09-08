'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reconcile = require('../reconcile-strict-export');

function master(size = 10000) {
  return Array.from({ length: size }, (_, i) => ({
    id: `legacy-${i}`,
    headline: `Legacy ${i}`,
    acquirer: `Buyer ${i}`,
    target: `Target ${i}`,
    dealType: 'Acquisition',
    dateISO: '2020-01-01',
    sourceUrl: `https://example.com/${i}`,
  }));
}

function strict(overrides = {}) {
  return {
    id: 'legacy-5',
    headline: 'Buyer 5 / Target 5',
    acquirer: 'Buyer 5',
    target: 'Target 5',
    dealType: 'Acquisition',
    dateISO: '2020-01-01',
    sourceUrl: 'https://example.com/5',
    reviewStatus: 'verified',
    reviewRuleVersion: 'strict-control-v3',
    ...overrides,
  };
}

test('strict export upgrades matching legacy rows without deleting the master corpus', () => {
  const input = master();
  const result = reconcile.reconcile(input, [strict()]);
  assert.equal(result.deals.length, input.length);
  assert.equal(result.replaced, 1);
  assert.equal(result.added, 0);
  const upgraded = result.deals.find(row => row.id === 'legacy-5');
  assert.equal(upgraded.reviewStatus, 'verified');
});

test('new strict rows are added without shrinking historical data', () => {
  const input = master();
  const result = reconcile.reconcile(input, [strict({ id: 'strict-new', sourceUrl: 'https://example.org/new', acquirer: 'New Buyer', target: 'New Target', dateISO: '2026-09-07' })]);
  assert.equal(result.deals.length, input.length + 1);
  assert.equal(result.added, 1);
});

test('empty or non-verified strict exports are refused', () => {
  assert.throws(() => reconcile.reconcile(master(), []), /strict export is empty/);
  assert.throws(() => reconcile.reconcile(master(), [strict({ reviewStatus: 'needs_review' })]), /non-verified/);
});

test('unexpectedly small master corpus is refused', () => {
  assert.throws(() => reconcile.reconcile(master(100), [strict()]), /historical master is missing or unexpectedly small/);
});
