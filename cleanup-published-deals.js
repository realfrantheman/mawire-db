'use strict';

const fs = require('fs');

const INPUT = process.env.DEALS_FILE || 'deals.json';
const FILING_AGENT = /^(?:BCP Investment Corp|EDGARFILINGS LTD|Toppan Merrill\/FA|.*(?:Filing Services|Filing Agent)|Donnelley Financial.*)$/i;
const UNKNOWN = /^(?:unknown(?: acquirer| target)?|undisclosed|null|n\/a)?$/i;
const STOP = new Set(['announces', 'announcement', 'acquisition', 'acquires', 'acquire', 'merger', 'with', 'the', 'and', 'for', 'inc', 'corp', 'corporation', 'company', 'ltd', 'llc', 'plc']);

function reliable(value) {
  return !!value && !UNKNOWN.test(String(value).trim()) && !FILING_AGENT.test(String(value).trim());
}

function headlineEntity(headline) {
  const first = String(headline || '').split(/\s+\/\s+| — /)[0]
    .replace(/\s+\([A-Z][A-Z0-9, -]*\).*$/, '')
    .replace(/\s+\(CIK\s+\d+\).*$/i, '')
    .trim();
  return reliable(first) ? first : null;
}

function extractHeadlineParties(headline) {
  const text = String(headline || '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const patterns = [
    /^(.+?)\s+(?:acquires|acquired|to acquire|will acquire|agrees to acquire|announces acquisition of)\s+(.+?)(?:\s+for\s+|\s+in\s+|$)/i,
    /^(.+?)\s+to be acquired by\s+(.+?)(?:\s+for\s+|\s+in\s+|$)/i,
    /^(.+?)\s+\/\s+(.+)$/,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    const left = match[1].replace(/\s+(?:announces|accelerates|strengthens).*$/i, '').trim();
    const right = match[2].replace(/\s+(?:for|in a transaction|through).*$/i, '').trim();
    if (!reliable(left) || !reliable(right)) continue;
    return index === 1 ? { acquirer: right, target: left } : { acquirer: left, target: right };
  }
  return {};
}

function repairFilingAgentParties(deal) {
  const filer = headlineEntity(deal.headline);
  const type = String(deal.filingType || '').toUpperCase();
  const badAcquirer = FILING_AGENT.test(String(deal.acquirer || ''));
  const badTarget = FILING_AGENT.test(String(deal.target || ''));
  if (!badAcquirer && !badTarget) {
    if (filer && /^S-4/.test(type) && reliable(deal.acquirer) && deal.acquirer !== filer) deal.acquirer = filer;
    if (filer && /SC TO-T|DEFM14A|DEFA14A/.test(type) && (!reliable(deal.target) || deal.target !== filer)) deal.target = filer;
    return deal;
  }

  if (badAcquirer) {
    deal.acquirer = 'Undisclosed';
    deal.extractedAcquirer = null;
    if (/SC TO-T|DEFM14A|DEFA14A/.test(type) && filer) deal.target = filer;
    if (/^S-4/.test(type) && filer) deal.acquirer = filer;
  }
  if (badTarget) {
    deal.target = filer && filer !== deal.acquirer ? filer : 'Undisclosed';
    deal.extractedTarget = null;
  }
  deal.headline = `${deal.acquirer || 'Undisclosed'} / ${deal.target || 'Undisclosed'}`;
  deal.summary = null;
  deal.body = null;
  deal.confidence = Math.min(Number(deal.confidence) || 0.45, 0.45);
  deal.needsReview = true;
  return deal;
}

function recoverHeadlineParties(deal) {
  const parties = extractHeadlineParties(deal.headline);
  if (reliable(deal.acquirer) && deal.acquirer === deal.target && reliable(parties.target) && parties.target !== deal.target) {
    deal.acquirer = 'Undisclosed';
    deal.target = parties.target;
    deal.headline = `Undisclosed / ${deal.target}`;
    deal.needsReview = true;
    return deal;
  }
  if (!reliable(deal.acquirer) && reliable(parties.acquirer)) deal.acquirer = parties.acquirer;
  if (!reliable(deal.target) && reliable(parties.target)) deal.target = parties.target;
  return deal;
}

function cleanExtractedEntity(value) {
  return String(value || '').replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function reconcileLowConfidenceParties(deal) {
  if (!deal.needsReview && Number(deal.confidence) > 0.5) return deal;
  const extractedTarget = cleanExtractedEntity(deal.extractedTarget);
  const extractedAcquirer = cleanExtractedEntity(deal.extractedAcquirer);
  let changed = false;
  if (/\(CIK\s+\d+\)/i.test(deal.extractedTarget || '') && reliable(extractedTarget) && extractedTarget !== deal.target) {
    deal.target = extractedTarget;
    changed = true;
  }
  if (/\(CIK\s+\d+\)/i.test(deal.extractedAcquirer || '') && reliable(extractedAcquirer) &&
      (!reliable(deal.acquirer) || deal.acquirer === deal.target)) {
    deal.acquirer = extractedAcquirer;
    changed = true;
  }
  if (changed) {
    deal.headline = `${deal.acquirer || 'Undisclosed'} / ${deal.target || 'Undisclosed'}`;
    deal.summary = null;
    deal.body = null;
    deal.needsReview = true;
  }
  return deal;
}

function repairSecSource(deal) {
  const url = String(deal.sourceUrl || deal.edgarUrl || '');
  if (!/sec\.gov\/Archives\/edgar\/data\//i.test(url)) return deal;
  const storedAccession = String(deal.accessionNo || '').match(/^(\d{10})-(\d{2})-(\d{6})/);
  const match = url.match(/sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})(?:\/[^/?#]+)?/i);
  if (!storedAccession && !match) return deal;
  const folder = match?.[2];
  const accession = storedAccession
    ? `${storedAccession[1]}-${storedAccession[2]}-${storedAccession[3]}`
    : `${folder.slice(0, 10)}-${folder.slice(10, 12)}-${folder.slice(12)}`;
  const fallback = `https://www.sec.gov/edgar/search/#/q=${accession}`;
  deal.sourceUrl = fallback;
  deal.edgarUrl = fallback;
  deal.needsReview = true;
  return deal;
}

function suspiciousArchiveCiks(deals) {
  const stats = new Map();
  for (const deal of deals) {
    const match = String(deal.sourceUrl || deal.edgarUrl || '').match(/sec\.gov\/Archives\/edgar\/data\/(\d+)\//i);
    if (!match) continue;
    if (!stats.has(match[1])) stats.set(match[1], { count: 0, entities: new Set() });
    const stat = stats.get(match[1]);
    stat.count++;
    if (reliable(deal.target)) stat.entities.add(String(deal.target).toLowerCase());
  }
  return new Set([...stats].filter(([, stat]) => stat.count >= 20 && stat.entities.size >= 20).map(([cik]) => cik));
}

function meaningfulTokens(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 3 && !STOP.has(token)));
}

function clearSuspiciousNewsSource(deal) {
  if (!/prnewswire\.com/i.test(deal.sourceUrl || '')) return deal;
  const headline = meaningfulTokens(deal.headline);
  const source = meaningfulTokens(deal.sourceUrl);
  const overlap = [...headline].filter(token => source.has(token));
  if (headline.size && overlap.length === 0) {
    deal.sourceUrl = null;
    deal.needsReview = true;
  }
  return deal;
}

function score(deal) {
  return (deal.sourceUrl ? 4 : 0) + (deal.edgarUrl ? 3 : 0) + (reliable(deal.acquirer) ? 2 : 0) +
    (reliable(deal.target) ? 2 : 0) + (deal.dealValue && deal.dealValue !== 'Undisclosed' ? 1 : 0);
}

function transactionKey(deal) {
  const date = String(deal.dateISO || deal.date || '').slice(0, 10);
  if (!date || !reliable(deal.acquirer) && !reliable(deal.target)) return null;
  return `${String(deal.acquirer || 'Undisclosed').toLowerCase()}|${String(deal.target || 'Undisclosed').toLowerCase()}|${date}`;
}

function cleanup(deals) {
  const repaired = deals
    .map(deal => clearSuspiciousNewsSource(reconcileLowConfidenceParties(recoverHeadlineParties(repairFilingAgentParties({ ...deal })))))
    .filter(deal => reliable(deal.acquirer) || reliable(deal.target));
  const output = [];
  const sourceIndex = new Map();
  const transactionIndex = new Map();
  for (const deal of repaired) {
    const source = deal.sourceUrl || deal.edgarUrl;
    const sourceKey = source && !/sec\.gov\/edgar\/search\/#\/q=/i.test(source)
      ? source.replace(/[?#].*$/, '').toLowerCase()
      : null;
    const dealKey = transactionKey(deal);
    const index = sourceKey && sourceIndex.has(sourceKey) ? sourceIndex.get(sourceKey) :
      dealKey && transactionIndex.has(dealKey) ? transactionIndex.get(dealKey) : undefined;
    if (index === undefined) {
      const newIndex = output.push(deal) - 1;
      if (sourceKey) sourceIndex.set(sourceKey, newIndex);
      if (dealKey) transactionIndex.set(dealKey, newIndex);
    } else if (score(deal) > score(output[index])) {
      output[index] = deal;
    }
  }
  return output.map(deal => repairSecSource(deal));
}

if (require.main === module) {
  const deals = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const cleaned = cleanup(deals);
  fs.writeFileSync(INPUT, `${JSON.stringify(cleaned, null, 2)}\n`);
  console.log(`[CLEANUP] ${deals.length} -> ${cleaned.length}; removed ${deals.length - cleaned.length} duplicate or unpublishable records`);
}

module.exports = { cleanup, headlineEntity, extractHeadlineParties, repairFilingAgentParties, clearSuspiciousNewsSource, repairSecSource, suspiciousArchiveCiks, reconcileLowConfidenceParties };
