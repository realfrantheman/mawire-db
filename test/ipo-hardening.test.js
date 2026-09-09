'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileRecords, mergeTerminal, genericMarketGuard } = require('../harden-ipo-artifact');
const { isActive } = require('../ipo-data');

function source(type = 'exchange') {
  return { title: 'Verified source', url: 'https://example.com/source', publisher: 'Exchange', date: '2026-06-12', type, confidence: 1 };
}

test('verified completed IPO cannot regress to filed on a later refresh', () => {
  const previous = [{ name: 'Atlas', cik: '100', status: 'completed', ipoDate: '2026-06-12', ticker: 'ATLS', exchange: 'Nasdaq', latestUpdateDate: '2026-06-12', sourceUrl: 'https://example.com/source', sources: [source()] }];
  const refreshed = [{ name: 'Atlas Inc.', cik: '100', status: 'filed', filingType: 'S-1', filingDate: '2026-06-03', latestUpdateDate: '2026-06-03', sourceUrl: 'https://www.sec.gov/a', sources: [{ title: 'Atlas S-1', url: 'https://www.sec.gov/a', publisher: 'SEC', date: '2026-06-03', type: 'filing', confidence: 1 }] }];
  const [record] = reconcileRecords(previous, refreshed);
  assert.equal(record.status, 'completed');
  assert.equal(record.ticker, 'ATLS');
  assert.equal(record.expected, null);
  assert.equal(isActive(record), false);
});

test('verified listed IPO cannot regress to amended', () => {
  const previous = { name: 'Atlas', cik: '100', status: 'listed', ipoDate: '2026-06-12', ticker: 'ATLS', exchange: 'NYSE', latestUpdateDate: '2026-06-12', sourceUrl: 'https://example.com/source', sources: [source()] };
  const incoming = { name: 'Atlas', cik: '100', status: 'amended', filingType: 'S-1/A', filingDate: '2026-06-10', latestUpdateDate: '2026-06-10', sourceUrl: 'https://www.sec.gov/b', sources: [{ title: 'Atlas S-1/A', url: 'https://www.sec.gov/b', publisher: 'SEC', date: '2026-06-10', type: 'filing', confidence: 1 }] };
  const record = mergeTerminal(previous, incoming);
  assert.equal(record.status, 'listed');
  assert.equal(isActive(record), false);
});

test('past verified market identity is never left active', () => {
  const guarded = genericMarketGuard({ name: 'Atlas', cik: '100', status: 'filed', ipoDate: '2026-06-12', ticker: 'ATLS', exchange: 'Nasdaq', latestUpdateDate: '2026-06-12', sourceUrl: 'https://example.com/source', sources: [source()] }, '2026-09-09');
  assert.equal(guarded.status, 'listed');
  assert.equal(guarded.expected, null);
});
