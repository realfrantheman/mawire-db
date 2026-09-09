'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRecord } = require('../ipo-data');
const { parseTextMetadata, parseSubmissionMetadata } = require('../ipo-enrichment');

test('SEC filing extraction separates offering economics from valuation', () => {
  const parsed = parseTextMetadata(`
    <p>We are offering 12,500,000 shares of common stock.</p>
    <p>We anticipate that the initial public offering price will be between $18 and $20 per share.</p>
    <p>The aggregate offering price is $250 million.</p>
    <p>Our common stock has been approved for listing on Nasdaq under trading symbol TEST.</p>
  `);
  assert.equal(parsed.ticker, 'TEST');
  assert.equal(parsed.exchange, 'Nasdaq');
  assert.equal(parsed.priceRange, '$18–$20/share');
  assert.equal(parsed.sharesOffered, '12,500,000');
  assert.equal(parsed.sharesOfferedNum, 12500000);
  assert.equal(parsed.offeringSize, '$250M');
  assert.equal(parsed.offeringSizeNum, 250000000);
  assert.equal(Object.hasOwn(parsed, 'valuation'), false);
  assert.equal(Object.hasOwn(parsed, 'valuationNum'), false);
});

test('SEC filing extraction leaves genuinely unavailable economics null', () => {
  const parsed = parseTextMetadata('<p>The registrant filed a Form S-1 with the SEC.</p>');
  assert.equal(parsed.priceRange, null);
  assert.equal(parsed.sharesOffered, null);
  assert.equal(parsed.offeringSize, null);
});

test('SEC submissions provide authoritative market identity and headquarters fallback', () => {
  const parsed = parseSubmissionMetadata({
    tickers: ['TEST'],
    exchanges: ['Nasdaq'],
    sicDescription: 'Prepackaged Software',
    addresses: { business: { street1: '1 Main Street', city: 'New York', stateOrCountry: 'NY', zipCode: '10001' } },
  });
  assert.deepEqual(parsed, {
    ticker: 'TEST', exchange: 'Nasdaq', industry: 'Prepackaged Software',
    headquarters: '1 Main Street, New York, NY, 10001',
  });
});

test('normalization preserves source-backed IPO enrichment fields', () => {
  const record = normalizeRecord({
    name: 'Example Co', cik: '123', sourceUrl: 'https://www.sec.gov/example', filingDate: '2026-09-09', filingType: 'S-1',
    priceRange: '$18–$20/share', sharesOffered: '12,500,000', sharesOfferedNum: 12500000,
    offeringSize: '$250M', offeringSizeNum: 250000000, headquarters: 'New York, NY',
  });
  assert.equal(record.priceRange, '$18–$20/share');
  assert.equal(record.sharesOfferedNum, 12500000);
  assert.equal(record.offeringSizeNum, 250000000);
  assert.equal(record.headquarters, 'New York, NY');
});
