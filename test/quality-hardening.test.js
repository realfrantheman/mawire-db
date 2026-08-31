'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const src = require('../FIX-source-url');
const publicData = require('../build-public-artifacts');

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

test('non-M&A types never enter public index', () => {
  assert.equal(publicData.isPublicTransaction({headline:'A invests in B',dealType:'Strategic Investment',acquirer:'A',target:'B'}), false);
  assert.equal(publicData.isPublicTransaction({headline:'A acquires B',dealType:'Acquisition',acquirer:'A',target:'B'}), true);
});

test('compact records omit long body and summary payloads', () => {
  const x=publicData.compactDeal({id:'1',headline:'A acquires B',body:'long',summary:'summary',sourceUrl:'https://example.com'});
  assert.equal(x.body, undefined); assert.equal(x.summary, undefined); assert.equal(x.headline,'A acquires B');
});
