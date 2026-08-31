'use strict';

const fs = require('fs');

const records = JSON.parse(fs.readFileSync('ipos.json', 'utf8'));
const activeStatuses = new Set(['rumored', 'filed', 'amended', 'priced', 'delayed', 'private']);
const sourceDates = records.map(record => record.latestUpdateDate || record.filingDate).filter(Boolean).sort();

const manifest = {
  generatedAt: new Date().toISOString(),
  recordCount: records.length,
  activeCount: records.filter(record => activeStatuses.has(record.status)).length,
  newestSourceUpdate: sourceDates.at(-1) || null,
  oldestSourceUpdate: sourceDates[0] || null,
  freshnessSlaMinutes: 120,
};

fs.writeFileSync('ipo-freshness.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('[IPO-FRESHNESS]', JSON.stringify(manifest));
