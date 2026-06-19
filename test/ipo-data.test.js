'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const overrides = require('../ipo-overrides.json');
const { normalizeRecord, dedupeRecords, applyOverrides, normalizeGraph, isActive } = require('../ipo-data');
const { FORMS, directFilingUrl, buildArtifact, validateArtifact } = require('../fetch-ipos');
const { extractEdgesFromFiling } = require('../build-ipo-dependency-graphs');

test('generator covers the SEC IPO lifecycle form family', () => {
  for (const form of ['S-1', 'S-1/A', 'F-1', 'F-1/A', '424B4', '424B1', 'EFFECT', 'RW', 'RW WD']) assert.ok(FORMS.includes(form));
});

test('direct SEC filing URL uses issuer CIK rather than accession prefix', () => {
  const hit = { _id: '0001193125-26-123456:prospectus.htm', _source: { ciks: ['0001181412'] } };
  assert.equal(directFilingUrl(hit), 'https://www.sec.gov/Archives/edgar/data/1181412/000119312526123456/prospectus.htm');
});

test('lifecycle forms classify completed and withdrawn records', () => {
  assert.equal(normalizeRecord({ name: 'Atlas', filingDate: '2026-01-01', sourceUrl: 'https://sec.gov/a', lifecycleFilings: [{ form: '424B4', date: '2026-03-01' }] }).status, 'completed');
  assert.equal(normalizeRecord({ name: 'Harbor', filingDate: '2026-01-01', sourceUrl: 'https://sec.gov/b', lifecycleFilings: [{ form: 'S-1', date: '2026-01-01' }, { form: 'RW', date: '2026-03-01' }] }).status, 'withdrawn');
});

test('deduplicates by CIK and preserves one stable slug', () => {
  const result = dedupeRecords([
    { name: 'Atlas Inc.', cik: '100', filingDate: '2026-01-01', sourceUrl: 'https://sec.gov/a' },
    { name: 'Atlas Corporation', cik: '100', filingDate: '2026-02-01', sourceUrl: 'https://sec.gov/b' },
  ]);
  assert.equal(result.length, 1);
  assert.match(result[0].id, /^ipo-/);
  assert.ok(result[0].slug);
});

test('SpaceX override is completed and excluded from active watchlist', () => {
  const records = applyOverrides([], overrides);
  const spacex = records.find(record => record.cik === '1181412');
  assert.equal(spacex.status, 'completed');
  assert.equal(spacex.ticker, 'SPCX');
  assert.equal(isActive(spacex), false);
});

test('dependency graph rejects unsourced or low-confidence edges', () => {
  const graph = normalizeGraph({ publicCompaniesIPOCompanyDependsOn: [
    { company: 'Amazon', sourceUrl: '', confidence: 0.95 },
    { company: 'NVIDIA', sourceUrl: 'https://sec.gov/filing', confidence: 0.5 },
  ] });
  assert.equal(graph.publicCompaniesIPOCompanyDependsOn.length, 0);
});

test('deterministic filing extraction only creates sourced explicit dependencies', () => {
  const graph = extractEdgesFromFiling({ name: 'Atlas' }, 'We rely on Amazon Web Services to host our production platform.', 'https://sec.gov/atlas-s1');
  assert.equal(graph.publicCompaniesIPOCompanyDependsOn[0].ticker, 'AMZN');
  assert.equal(graph.publicCompaniesIPOCompanyDependsOn[0].confidence, 0.92);
  assert.equal(extractEdgesFromFiling({ name: 'Atlas' }, 'Amazon is a large technology company.', 'https://sec.gov/atlas-s1').publicCompaniesIPOCompanyDependsOn.length, 0);
});

test('dependency extraction rejects aspirational marketing references', () => {
  const graph = extractEdgesFromFiling(
    { name: 'Example Co' },
    'We plan to utilize Facebook for social media marketing to reach our target audience.',
    'https://www.sec.gov/Archives/edgar/data/1/example.htm',
  );
  assert.equal(graph.publicCompaniesIPOCompanyDependsOn.length, 0);
});

test('artifact validation requires stable fields and verified SpaceX status', () => {
  const records = buildArtifact([], overrides);
  assert.doesNotThrow(() => validateArtifact(records));
  assert.throws(() => validateArtifact([{ ...records[0], status: 'filed' }]), /SpaceX/);
});
