'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanup, repairFilingAgentParties, clearSuspiciousNewsSource, repairSecSource } = require('../cleanup-published-deals');
const { reconstructEdgarUrl } = require('../FIX-export-to-github');

test('removes filing agents from deal parties without inventing a buyer', () => {
  const deal = repairFilingAgentParties({ headline: 'Organon & Co. / Unknown target', acquirer: 'BCP Investment Corp', target: 'Organon & Co.', filingType: 'DEFA14A' });
  assert.equal(deal.acquirer, 'Undisclosed');
  assert.equal(deal.target, 'Organon & Co.');
  assert.equal(deal.needsReview, true);
});

test('keeps one best record per exact transaction source', () => {
  const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/1/2/deal.htm';
  const result = cleanup([{ id: 'a', sourceUrl }, { id: 'b', sourceUrl, target: 'Target Inc.' }]);
  assert.deepEqual(result.map(deal => deal.id), ['b']);
});

test('clears unrelated PR Newswire links', () => {
  const deal = clearSuspiciousNewsSource({ sourceUrl: 'https://www.prnewswire.com/news-releases/unrelated-301.html', source: 'PR Newswire' });
  assert.equal(deal.sourceUrl, null);
});

test('recovers reliable parties from acquisition headlines', () => {
  const deal = repairFilingAgentParties({ headline: 'Buyer Inc. to acquire Target Corp.', acquirer: 'Unknown', target: 'Unknown' });
  assert.equal(deal.acquirer, 'Buyer Inc.');
  assert.equal(deal.target, 'Target Corp.');
});

test('preserves direct SEC filing documents', () => {
  const url = 'https://www.sec.gov/Archives/edgar/data/123/456789/example.htm';
  const deal = repairSecSource({ sourceUrl: url, filingType: 'DEFM14A' });
  assert.equal(deal.sourceUrl, url);
});

test('removes generic SEC search links instead of publishing them as evidence', () => {
  const deal = repairSecSource({ sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany', filingType: 'DEFM14A' });
  assert.equal(deal.sourceUrl, null);
});

test('export reconstructs direct SEC Archives filing index URL from CIK and accession', () => {
  const url = reconstructEdgarUrl({ filingCik: '123456', accessionNo: '0000123456-26-000001' });
  assert.match(url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/123456\/000012345626000001\//);
});

test('repairs repeated self-party contamination from the headline', () => {
  const deal = repairFilingAgentParties({ headline: 'Buyer Corp to acquire Target Inc.', acquirer: 'Buyer Corp', target: 'Buyer Corp' });
  assert.equal(deal.acquirer, 'Buyer Corp');
  assert.equal(deal.target, 'Target Inc.');
});

test('prefers a CIK-backed extracted target for a low-confidence conflict', () => {
  const deal = repairFilingAgentParties({ headline: 'Buyer Corp to acquire Target Inc.', acquirer: 'Buyer Corp', target: 'Wrong Target', targetCik: null, extractedTarget: 'Target Inc.', confidence: 0.4 });
  assert.ok(deal.target);
});

test('does not publish records with no identifiable party', () => {
  const result = cleanup([{ id: 'a', headline: 'Transaction update', acquirer: 'Unknown', target: 'Unknown', sourceUrl: 'https://example.com/deal' }]);
  assert.equal(result.length, 0);
});

test('does not publish low-confidence news targets contaminated by promotional copy', () => {
  const result = cleanup([{ id: 'a', headline: 'Buyer acquires Target', acquirer: 'Buyer', target: 'Target, creating a leader', sourceType: 'news_rss', confidence: 0.4, sourceUrl: 'https://example.com/deal' }]);
  assert.equal(result.length, 0);
});
