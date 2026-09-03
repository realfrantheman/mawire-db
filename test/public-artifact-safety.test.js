'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const publicData = require('../build-public-artifacts');

function verified(overrides = {}) {
  return {
    id: 'strict-1',
    headline: 'Buyer Corp / Target Inc.',
    acquirer: 'Buyer Corp',
    target: 'Target Inc.',
    dealType: 'Acquisition',
    reviewStatus: 'verified',
    reviewRuleVersion: 'strict-control-v3',
    sourceType: 'sec_edgar',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/source.htm',
    dateISO: '2026-09-03',
    year: 2026,
    ...overrides,
  };
}

test('strict publication rejects SEC boilerplate mis-extracted as a party', () => {
  const badParties = [
    'Passage. Additionally, following April 20, 2026, Passage made PBFT02 program info',
    'Slate does not close',
    'the Secretary of State of the State of Delaware and making such other filings or',
    'Parent or the Surviving Company, as applicable, as a result of, or',
    'the Delaware Secretary of State',
  ];
  for (const target of badParties) {
    assert.equal(publicData.isPublicTransaction(verified({ target })), false, target);
  }
});

test('historical public corpus is preserved while strict additions remain gated', () => {
  const legacyIndex = [
    { id: 'legacy-1', headline: 'Legacy record', acquirer: 'Undisclosed', target: 'Legacy Target', dealType: 'Merger', sourceUrl: 'https://example.com/legacy' },
  ];
  const input = [
    { ...legacyIndex[0], body: 'historical detail' },
    verified(),
    verified({ id: 'bad-strict', target: 'the Delaware Secretary of State' }),
  ];
  const result = publicData.buildArtifacts(input, { legacyIndex });
  assert.equal(result.index.length, 2);
  assert.equal(result.index[0].id, 'strict-1');
  assert.deepEqual(result.index[1], legacyIndex[0]);
  assert.equal(result.manifest.legacyRecordCount, 1);
  assert.equal(result.manifest.strictVerifiedCount, 1);
});
