'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const src = require('../FIX-source-url');
const publicData = require('../build-public-artifacts');

function verified(overrides = {}) {
  return {
    id: '1',
    headline: 'Buyer Corp agrees to acquire Target Inc.',
    acquirer: 'Buyer Corp',
    target: 'Target Inc.',
    dealType: 'Acquisition',
    reviewStatus: 'verified',
    reviewRuleVersion: 'strict-control-v3',
    sourceType: 'news_rss',
    sourceUrl: 'https://example.com/primary-release',
    ...overrides,
  };
}

test('SEC landing/index URL becomes direct submission document', () => {
  const url = src.canonicalSecDocumentUrl({ sourceType:'sec_filing', edgarUrl:'https://www.sec.gov/Archives/edgar/data/128994526000035/000128994526000035/0001289945-26-000035-index.html' });
  assert.equal(url, 'https://www.sec.gov/Archives/edgar/data/1289945/000128994526000035/0001289945-26-000035.txt');
  assert.equal(src.isDirectSecArchiveFile(url), true);
});

test('direct SEC primary document is preserved', () => {
  const url='https://www.sec.gov/Archives/edgar/data/1773383/000177338326000033/dynatrace-notice2026.htm';
  assert.equal(src.canonicalSecDocumentUrl({sourceType:'sec_edgar',documentUrl:url}), url);
});

test('search/feed landing URLs are rejected', () => {
  assert.equal(src.isLandingPage('https://efts.sec.gov/LATEST/search-index?forms=S-4'), true);
  assert.equal(src.isLandingPage('https://www.prnewswire.com/news-releases/example.html'), false);
});

test('only verified control-transaction types enter public index', () => {
  assert.equal(publicData.isPublicTransaction(verified()), true);
  assert.equal(publicData.isPublicTransaction(verified({ dealType:'Strategic Investment' })), false);
  assert.equal(publicData.isPublicTransaction(verified({ dealType:'Funding Round' })), false);
  assert.equal(publicData.isPublicTransaction(verified({ reviewStatus:'needs_review' })), false);
  assert.equal(publicData.isPublicTransaction(verified({ reviewRuleVersion:'old-rule' })), false);
});

test('unresolved or same-party records never enter public index', () => {
  assert.equal(publicData.isPublicTransaction(verified({ acquirer:'Undisclosed' })), false);
  assert.equal(publicData.isPublicTransaction(verified({ target:'Unknown' })), false);
  assert.equal(publicData.isPublicTransaction(verified({ acquirer:'Target Inc.', target:'Target Inc.' })), false);
});

test('compact records omit long body and summary payloads', () => {
  const x=publicData.compactDeal(verified({body:'long',summary:'summary'}));
  assert.equal(x.body, undefined);
  assert.equal(x.summary, undefined);
  assert.equal(x.headline,'Buyer Corp agrees to acquire Target Inc.');
});
