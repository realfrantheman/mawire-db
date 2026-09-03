'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }

test('deployment controller owns all referenced site runtime assets', () => {
  const deploy = read('deploy.py');
  assert.match(deploy, /'DEPLOY-charts\.js'\s*,\s*'mawire-site'\s*,\s*'charts\.js'/);
  assert.match(deploy, /'DEPLOY-about\.js'\s*,\s*'mawire-site'\s*,\s*'about\.js'/);
});

test('site-owned brand assets cannot be overwritten by runtime deployments', () => {
  const deploy = read('deploy.py');
  assert.doesNotMatch(deploy, /\('style\.css'\s*,\s*'mawire-site'\s*,\s*'style\.css'\)/);
  assert.doesNotMatch(deploy, /\('DEPLOY-manifest\.json'\s*,\s*'mawire-site'\s*,\s*'manifest\.json'\)/);
  assert.doesNotMatch(deploy, /\('icon-192\.png'\s*,\s*'mawire-site'\s*,\s*'icon-192\.png'\)/);
  assert.doesNotMatch(deploy, /\('icon-512\.png'\s*,\s*'mawire-site'\s*,\s*'icon-512\.png'\)/);
});

test('deployment controller owns the active platform entrypoint', () => {
  const deploy = read('deploy.py');
  const pkg = read('DEPLOY-platform-package.json');
  const nixpacks = read('DEPLOY-platform-nixpacks.toml');
  assert.match(deploy, /'DEPLOY-platform-package\.json'\s*,\s*'mawire-platform'\s*,\s*'package\.json'/);
  assert.match(deploy, /'DEPLOY-platform-nixpacks\.toml'\s*,\s*'mawire-platform'\s*,\s*'nixpacks\.toml'/);
  assert.match(pkg, /"start"\s*:\s*"npm run start:scheduler"/);
  assert.match(pkg, /"start:scheduler"\s*:\s*"node scripts\/migrate\.js && node scheduler\.js"/);
  assert.match(nixpacks, /cmd\s*=\s*"npm run start:scheduler"/);
  assert.doesNotMatch(pkg + nixpacks, /frozen-platform/);
});

test('production deal index bypasses custom-domain Cloudflare challenges', () => {
  const deploy = read('deploy.py');
  const integrity = read('FIX-file-integrity.js');
  const endpoint = /https:\/\/raw\.githubusercontent\.com\/realfrantheman\/mawire-db\/main\/deals-index\.json/;
  assert.match(deploy, endpoint);
  assert.match(integrity, endpoint);
  assert.doesNotMatch(deploy, /PUBLIC_DATA_URL\s*=\s*['"]\/deals-index\.json['"]/);
});

test('service worker never converts deal-data failure into an empty success', () => {
  const sw = read('FIX-sw.js');
  assert.match(sw, /deal_data_unavailable/);
  assert.match(sw, /status:\s*503/);
  assert.doesNotMatch(sw, /Response\s*\(\s*['"]\[\]['"]/);
});

test('deal chart range follows the runtime year', () => {
  const charts = read('DEPLOY-charts.js');
  assert.match(charts, /getUTCFullYear\(\)/);
  assert.doesNotMatch(charts, /<=\s*2026/);
});

test('APAC is stored as region rather than sector', () => {
  const apac = read('FIX-apac-ingestor.js');
  assert.match(apac, /NULL,'APAC'/);
  assert.doesNotMatch(apac, /sector\s*:\s*['"]Asia Pacific['"]/i);
});

test('enrichment returns changed deals to strict review instead of publishing them', () => {
  const enrichment = read('FIX-enrich-deals.js');
  assert.match(enrichment, /needs_review=true/);
  assert.match(enrichment, /review_status='pending'/);
});

test('EU prohibited transactions map to terminated, not withdrawn', () => {
  const eu = read('FIX-eu-ingestor.js');
  assert.match(eu, /prohibit\|blocked[\s\S]{0,120}return 'Terminated'/);
});

test('database SSL policy is consistent across DB maintenance workflows', () => {
  for (const path of [
    '.github/workflows/pie-monitor.yml',
    '.github/workflows/auto-backfill.yml',
    '.github/workflows/historical-backfill.yml',
    '.github/workflows/enrich-deals.yml'
  ]) {
    assert.match(read(path), /DATABASE_SSL_ALLOW_SELF_SIGNED:\s*['"]true['"]/);
  }
});

test('IPO page uses the authoritative live artifact and has no static current-status seed', () => {
  const loader = read('FIX-ipo-dynamic-loader.js');
  assert.match(loader, /raw\.githubusercontent\.com\/realfrantheman\/mawire-db\/main\/ipos\.json/);
  assert.match(loader, /cache:\s*['"]no-store['"]/);
  assert.doesNotMatch(loader, /var\s+IPO_COMPANIES\s*=\s*\[/);
  assert.match(loader, /temporarily unavailable/);
});

test('deal_value billions view correctly converts USD cents', () => {
  const schema = read('FIX-platform-schema.sql');
  assert.match(schema, /deal_value::double precision\s*\/\s*100000000000\.0/);
});
