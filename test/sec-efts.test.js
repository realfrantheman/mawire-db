'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const efts = require('../FIX-sec-efts');

test('SEC EFTS custom search always has explicit start and end dates', () => {
  const url = new URL(efts.buildSearchUrl('S-4/A', '2026-08-30', '2026-09-02', 100));
  assert.equal(url.searchParams.get('forms'), 'S-4');
  assert.equal(url.searchParams.get('dateRange'), 'custom');
  assert.equal(url.searchParams.get('startdt'), '2026-08-30');
  assert.equal(url.searchParams.get('enddt'), '2026-09-02');
  assert.equal(url.searchParams.get('from'), '100');
});

test('EFTS hit uses ciks metadata rather than accession-prefix filing-agent CIK', () => {
  const filing = efts.hitToFiling({
    _id: '0001193125-26-032000:ionq-ex99_2.htm',
    _source: {
      ciks: ['0001824920'],
      display_names: ['IonQ, Inc.  (IONQ)  (CIK 0001824920)'],
      root_forms: ['8-K'],
      form: '8-K',
      file_date: '2026-01-30',
      adsh: '0001193125-26-032000',
      file_type: 'EX-99.2',
      sequence: 2,
    },
  });
  assert.equal(filing.cik, '1824920');
  assert.equal(filing.entity_name, 'IonQ, Inc.');
  assert.equal(filing.accession_no, '0001193125-26-032000');
  assert.match(filing.filing_url, /\/edgar\/data\/1824920\/000119312526032000\/ionq-ex99_2\.htm$/);
});

test('root-form normalization queries amendments through their root form', () => {
  assert.equal(efts.normalizeRootForm('SC TO-T/A'), 'SC TO-T');
  assert.equal(efts.normalizeRootForm('S-4/A'), 'S-4');
  assert.equal(efts.normalizeRootForm('SC 13E-3/A'), 'SC 13E-3');
});

test('dedupe prefers the primary filing document for one accession', () => {
  const base = {
    accession_no: '0000123456-26-000001',
    cik: '123456',
    filing_date: '2026-09-02',
    raw: { form: 'S-4', file_type: 'EX-99.1', sequence: 2 },
  };
  const primary = { ...base, id: 'primary', raw: { form: 'S-4', file_type: 'S-4', sequence: 1 } };
  const exhibit = { ...base, id: 'exhibit' };
  const rows = efts.dedupeFilings([exhibit, primary]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'primary');
});
