'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanup, repairFilingAgentParties, clearSuspiciousNewsSource } = require('../cleanup-published-deals');

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
  const deal = clearSuspiciousNewsSource({ headline: 'BancFirst Announces Acquisition of SpiritBank', sourceUrl: 'https://www.prnewswire.com/news-releases/sony-semiconductor-releases-x-ray-sensor-123.html' });
  assert.equal(deal.sourceUrl, null);
});

test('recovers reliable parties from acquisition headlines', () => {
  const result = cleanup([{ id: 'a', headline: 'BancFirst Corporation Announces Acquisition of SpiritBank', acquirer: 'Undisclosed', target: 'Undisclosed', dateISO: '2026-06-10' }]);
  assert.equal(result[0].acquirer, 'BancFirst Corporation');
  assert.equal(result[0].target, 'SpiritBank');
});

test('does not publish records with no identifiable party', () => {
  assert.equal(cleanup([{ id: 'a', headline: 'Undisclosed / Undisclosed', acquirer: 'Undisclosed', target: 'Undisclosed', dateISO: '2026-06-10' }]).length, 0);
});
