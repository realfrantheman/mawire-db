'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanup, repairFilingAgentParties, clearSuspiciousNewsSource, repairSecSource } = require('../cleanup-published-deals');

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

test('replaces SEC archive paths with durable SEC accession search', () => {
  const repaired = repairSecSource({
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1493152/000149315226028363/formdefa14a.htm'
  });
  assert.equal(repaired.sourceUrl, 'https://www.sec.gov/edgar/search/#/q=0001493152-26-028363');
  assert.equal(repaired.needsReview, true);
});

test('repairs repeated self-party contamination from the headline', () => {
  const [repaired] = cleanup([{
    headline: 'OVERSEAS SHIPHOLDING GROUP INC / MOBIX LABS, INC',
    acquirer: 'OVERSEAS SHIPHOLDING GROUP INC',
    target: 'OVERSEAS SHIPHOLDING GROUP INC',
    dateISO: '2026-06-10'
  }]);
  assert.equal(repaired.acquirer, 'Undisclosed');
  assert.equal(repaired.target, 'MOBIX LABS, INC');
});

test('prefers a CIK-backed extracted target for a low-confidence conflict', () => {
  const [repaired] = cleanup([{
    headline: 'Undisclosed / OVERSEAS SHIPHOLDING GROUP INC',
    acquirer: 'Undisclosed',
    target: 'OVERSEAS SHIPHOLDING GROUP INC',
    extractedTarget: 'PERMA FIX ENVIRONMENTAL SERVICES INC (PESI) (CIK 0000891532)',
    confidence: 0.45,
    needsReview: true,
    dateISO: '2026-06-12'
  }]);
  assert.equal(repaired.target, 'PERMA FIX ENVIRONMENTAL SERVICES INC');
  assert.equal(repaired.headline, 'Undisclosed / PERMA FIX ENVIRONMENTAL SERVICES INC');
});

test('does not publish records with no identifiable party', () => {
  assert.equal(cleanup([{ id: 'a', headline: 'Undisclosed / Undisclosed', acquirer: 'Undisclosed', target: 'Undisclosed', dateISO: '2026-06-10' }]).length, 0);
});

test('does not publish low-confidence news targets contaminated by promotional copy', () => {
  assert.equal(cleanup([{
    id: 'a', headline: 'Factua Acquires Intelsio', acquirer: 'Factua',
    target: 'Intelsio, Bringing a Decade of Performance Marketing',
    dateISO: '2026-06-09', sourceType: 'news_rss', confidence: 0.5
  }]).length, 0);
});
