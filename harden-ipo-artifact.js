'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeRecord, recordKey, dedupeRecords, applyOverrides, isActive } = require('./ipo-data');

const TERMINAL = new Set(['listed', 'completed']);
const OVERRIDES = require('./ipo-overrides.json');

function uniqueByUrl(items = []) {
  const seen = new Set();
  return items.filter(Boolean).filter(item => {
    const key = String(item.url || `${item.form || item.filingType || ''}|${item.date || item.filingDate || ''}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeTerminal(previous, incoming) {
  const prior = normalizeRecord(previous);
  const next = normalizeRecord(incoming);
  if (!TERMINAL.has(prior.status) || !isActive(next)) return next;
  const lifecycleFilings = uniqueByUrl([
    ...(Array.isArray(previous.lifecycleFilings) ? previous.lifecycleFilings : []),
    ...(Array.isArray(incoming.lifecycleFilings) ? incoming.lifecycleFilings : []),
  ]);
  return normalizeRecord({
    ...next,
    status: prior.status,
    statusLabel: prior.statusLabel,
    ipoDate: prior.ipoDate,
    ticker: prior.ticker || next.ticker,
    exchange: prior.exchange || next.exchange,
    expected: null,
    valuation: next.valuation || prior.valuation,
    valuationNum: next.valuationNum || prior.valuationNum,
    sourceUrl: prior.sourceUrl || next.sourceUrl,
    source: prior.source || next.source,
    notes: prior.notes || next.notes,
    sources: uniqueByUrl([...(prior.sources || []), ...(next.sources || [])]),
    lifecycleFilings,
    latestUpdateDate: [prior.latestUpdateDate, next.latestUpdateDate].filter(Boolean).sort().pop(),
  });
}

function genericMarketGuard(record, today = new Date().toISOString().slice(0, 10)) {
  const normalized = normalizeRecord(record);
  const actualDate = normalized.ipoDate;
  if (isActive(normalized) && actualDate && actualDate <= today && normalized.ticker && normalized.exchange) {
    return normalizeRecord({ ...record, ...normalized, status: 'listed', statusLabel: 'Listed', expected: null });
  }
  if (TERMINAL.has(normalized.status) && normalized.expected) return { ...normalized, expected: null };
  return normalized;
}

function reconcileRecords(previousRecords = [], refreshedRecords = []) {
  const previous = new Map(previousRecords.map(record => {
    const normalized = normalizeRecord(record);
    return [recordKey(normalized), { raw: record, normalized }];
  }));
  const reconciled = refreshedRecords.map(record => {
    const normalized = normalizeRecord(record);
    const prior = previous.get(recordKey(normalized));
    return genericMarketGuard(prior ? mergeTerminal(prior.raw, record) : record);
  });
  const refreshedKeys = new Set(reconciled.map(recordKey));
  const preserved = previousRecords.filter(record => !refreshedKeys.has(recordKey(normalizeRecord(record)))).map(genericMarketGuard);
  return applyOverrides(dedupeRecords(preserved.concat(reconciled)), OVERRIDES).map(genericMarketGuard);
}

function main() {
  const previousPath = process.argv[2];
  const refreshedPath = process.argv[3] || path.join(__dirname, 'ipos.json');
  if (!previousPath) throw new Error('usage: node harden-ipo-artifact.js <previous.json> [refreshed.json]');
  const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
  const refreshed = JSON.parse(fs.readFileSync(refreshedPath, 'utf8'));
  const records = reconcileRecords(previous, refreshed);
  fs.writeFileSync(refreshedPath, `${JSON.stringify(records, null, 2)}\n`);
  const protectedCount = records.filter(record => TERMINAL.has(record.status)).length;
  console.log(JSON.stringify({ records: records.length, terminal: protectedCount, output: refreshedPath }));
}

module.exports = { reconcileRecords, mergeTerminal, genericMarketGuard };
if (require.main === module) main();
