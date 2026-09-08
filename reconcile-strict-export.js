'use strict';

const fs = require('fs');

const MASTER_FILE = process.argv[2] || process.env.MASTER_DEALS_FILE || 'deals.json';
const STRICT_FILE = process.argv[3] || process.env.STRICT_EXPORT_FILE || 'strict-export.json';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, '&')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').toLowerCase();
}

function accession(value) {
  const match = String(value || '').match(/(\d{10}-\d{2}-\d{6})/);
  return match ? match[1].toLowerCase() : '';
}

function identity(deal) {
  const date = String(deal?.dateISO || deal?.date || '').slice(0, 10);
  return {
    id: deal?.id ? String(deal.id) : '',
    accession: accession(deal?.accessionNo || deal?.sourceUrl || deal?.edgarUrl),
    source: cleanUrl(deal?.sourceUrl || deal?.edgarUrl),
    parties: deal?.acquirer && deal?.target && date
      ? `${normalize(deal.acquirer)}|${normalize(deal.target)}|${date}`
      : '',
  };
}

function isStrictVerified(deal) {
  return !!deal && deal.reviewStatus === 'verified' && /^strict-control-v\d+$/i.test(String(deal.reviewRuleVersion || ''));
}

function findMatch(master, strictDeal) {
  const candidate = identity(strictDeal);
  if (candidate.id) {
    const index = master.findIndex(row => identity(row).id === candidate.id);
    if (index >= 0) return index;
  }
  if (candidate.accession) {
    const index = master.findIndex(row => identity(row).accession === candidate.accession);
    if (index >= 0) return index;
  }
  if (candidate.parties) {
    const index = master.findIndex(row => identity(row).parties === candidate.parties);
    if (index >= 0) return index;
  }
  if (candidate.source) {
    const strictAcquirer = normalize(strictDeal.acquirer);
    const strictTarget = normalize(strictDeal.target);
    const index = master.findIndex(row => {
      const rowIdentity = identity(row);
      if (rowIdentity.source !== candidate.source) return false;
      const rowAcquirer = normalize(row.acquirer);
      const rowTarget = normalize(row.target);
      return !!((strictAcquirer && rowAcquirer === strictAcquirer) || (strictTarget && rowTarget === strictTarget));
    });
    if (index >= 0) return index;
  }
  return -1;
}

function reconcile(masterDeals, strictDeals) {
  if (!Array.isArray(masterDeals) || masterDeals.length < 10000) {
    throw new Error(`Refusing reconciliation: historical master is missing or unexpectedly small (${masterDeals?.length || 0})`);
  }
  if (!Array.isArray(strictDeals) || !strictDeals.length) {
    throw new Error('Refusing reconciliation: strict export is empty');
  }
  const invalidStrict = strictDeals.filter(deal => !isStrictVerified(deal));
  if (invalidStrict.length) throw new Error(`Strict export contains ${invalidStrict.length} non-verified record(s)`);

  const output = masterDeals.map(deal => ({ ...deal }));
  let replaced = 0;
  let added = 0;
  for (const strictDeal of strictDeals) {
    const index = findMatch(output, strictDeal);
    if (index >= 0) {
      output[index] = { ...output[index], ...strictDeal };
      replaced++;
    } else {
      output.unshift(strictDeal);
      added++;
    }
  }

  if (output.length < masterDeals.length) {
    throw new Error(`Reconciliation invariant failed: ${masterDeals.length} master rows became ${output.length}`);
  }
  return { deals: output, replaced, added };
}

function run(masterFile = MASTER_FILE, strictFile = STRICT_FILE) {
  const master = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
  const strict = JSON.parse(fs.readFileSync(strictFile, 'utf8'));
  const result = reconcile(master, strict);
  fs.writeFileSync(masterFile, `${JSON.stringify(result.deals, null, 2)}\n`);
  console.log(`[RECONCILE] master=${master.length} strict=${strict.length} replaced=${result.replaced} added=${result.added} final=${result.deals.length}`);
  return result;
}

if (require.main === module) run();

module.exports = { normalize, identity, isStrictVerified, findMatch, reconcile, run };
