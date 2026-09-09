'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const deploy = fs.readFileSync(path.join(__dirname, '..', 'deploy.py'), 'utf8');

test('database deployment cannot overwrite site-owned IPO page or Vercel config', () => {
  assert.match(deploy, /SITE_PROTECTED_DESTINATIONS\s*=\s*\{'ipo\.html', 'vercel\.json'\}/);
  assert.doesNotMatch(deploy, /\('DEPLOY-ipo\.html',\s*'mawire-site',\s*'ipo\.html'\)/);
  assert.doesNotMatch(deploy, /\('DEPLOY-vercel\.json',\s*'mawire-site',\s*'vercel\.json'\)/);
  assert.match(deploy, /protected site destination cannot be deployed from mawire-db/);
});

test('site-data-only mode remains restricted to verified public data artifacts', () => {
  assert.match(deploy, /PUBLIC_DATA_SOURCES\s*=\s*\{'deals-index\.json', 'deals-public-manifest\.json'\}/);
  assert.match(deploy, /if SITE_DATA_ONLY:/);
});
