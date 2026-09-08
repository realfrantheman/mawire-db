'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'FIX-quality-hardening.js'), 'utf8');

test('frontend preserves the established raw GitHub production deal index source', () => {
  assert.match(source, /var INDEX_URL = ROOT \+ 'deals-index\.json';/);
});

test('frontend explicitly recognizes unreviewed historical migration rows', () => {
  assert.match(source, /function isLegacyRecord\(d\)/);
  assert.match(source, /!d\.reviewStatus && !d\.reviewRuleVersion/);
});

test('reviewed rows still require strict verified status', () => {
  assert.match(source, /!isLegacyRecord\(d\).*d\.reviewStatus !== 'verified'.*d\.reviewRuleVersion !== 'strict-control-v3'/s);
});

test('old unconditional verified-only gate cannot return', () => {
  assert.doesNotMatch(source, /if \(d\.reviewStatus !== 'verified' \|\| d\.reviewRuleVersion !== 'strict-control-v3'\) return false;/);
});
