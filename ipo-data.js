'use strict';

const crypto = require('crypto');

const VALID_STATUSES = new Set(['rumored', 'filed', 'amended', 'priced', 'listed', 'withdrawn', 'delayed', 'completed', 'private', 'unknown']);
const ACTIVE_STATUSES = new Set(['rumored', 'filed', 'amended', 'priced', 'delayed', 'private']);
const FINAL_FORMS = new Set(['424B4', '424B1']);
const WITHDRAWAL_FORMS = new Set(['RW', 'RW WD']);
const ALLOWED_EDGE_TYPES = new Set(['depends_on_ipo_company', 'ipo_company_depends_on']);

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function isoDate(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
function slugify(value) {
  return cleanText(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'ipo-company';
}
function normalizedName(value) {
  return cleanText(value).toLowerCase().replace(/\([^)]*(?:cik|ticker|nasdaq|nyse)[^)]*\)/gi, '')
    .replace(/\b(?:incorporated|corporation|company|limited|holdings?|group|inc|corp|co|ltd|llc|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function stableId(record) {
  const identity = record.cik ? `cik:${String(record.cik).replace(/^0+/, '')}` : `name:${normalizedName(record.legalName || record.name)}`;
  return `ipo-${crypto.createHash('sha1').update(identity).digest('hex').slice(0, 16)}`;
}
function valuationNumber(value) {
  if (Number.isFinite(value)) return value;
  const match = String(value || '').replace(/,/g, '').match(/\$?([\d.]+)\s*([TMBK])?/i);
  if (!match) return null;
  const multiplier = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[String(match[2] || '').toUpperCase()] || 1;
  const result = Number(match[1]) * multiplier;
  return Number.isFinite(result) ? result : null;
}
function normalizeExchange(value) {
  const text = cleanText(value).toUpperCase();
  if (!text || text === '—' || text === '-') return null;
  if (/NASDAQ/.test(text)) return 'Nasdaq';
  if (/NYSE AMERICAN/.test(text)) return 'NYSE American';
  if (/NYSE|NEW YORK STOCK EXCHANGE/.test(text)) return 'NYSE';
  if (/LSE/.test(text)) return 'LSE';
  if (/HKEX|HONG KONG/.test(text)) return 'HKEX';
  if (/ASX/.test(text)) return 'ASX';
  return cleanText(value);
}
function sourceFromRecord(record) {
  if (!record.sourceUrl) return [];
  return [{
    title: `${cleanText(record.legalName || record.name)} ${cleanText(record.filingType || 'IPO filing')}`,
    url: record.sourceUrl,
    publisher: /sec\.gov/i.test(record.sourceUrl) ? 'SEC' : cleanText(record.source || 'Primary source'),
    date: isoDate(record.filingDate),
    type: /sec\.gov/i.test(record.sourceUrl) ? 'filing' : 'regulatory',
    confidence: /sec\.gov/i.test(record.sourceUrl) ? 0.95 : 0.8,
  }];
}
function normalizeSource(source) {
  if (!source || !/^https?:\/\//i.test(String(source.url || ''))) return null;
  const confidence = Math.max(0, Math.min(1, Number(source.confidence) || 0));
  return {
    title: cleanText(source.title || source.publisher || 'Source'), url: String(source.url),
    publisher: cleanText(source.publisher || 'Source'), date: isoDate(source.date),
    type: cleanText(source.type || 'regulatory'), confidence,
  };
}
function normalizeEdge(edge, direction) {
  if (!edge || !cleanText(edge.company) || !/^https?:\/\//i.test(String(edge.sourceUrl || ''))) return null;
  const confidence = Number(edge.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.6 || confidence > 1) return null;
  const dependencyType = direction === 'inbound' ? 'depends_on_ipo_company' : 'ipo_company_depends_on';
  if (edge.dependencyType && !ALLOWED_EDGE_TYPES.has(edge.dependencyType)) return null;
  return {
    company: cleanText(edge.company), ticker: cleanText(edge.ticker) || null,
    relationship: cleanText(edge.relationship || 'commercial relationship'), dependencyType,
    rationale: cleanText(edge.rationale), sourceUrl: String(edge.sourceUrl),
    sourceTitle: cleanText(edge.sourceTitle || 'Source'), confidence,
    ...(edge.extractionMethod ? { extractionMethod: cleanText(edge.extractionMethod) } : {}),
  };
}
function normalizeGraph(graph = {}) {
  const dedupe = edges => {
    const seen = new Set();
    return edges.filter(Boolean).filter(edge => {
      const key = `${String(edge.ticker || '').toLowerCase()}|${normalizedName(edge.company)}|${edge.relationship.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  };
  return {
    publicCompaniesDependingOnIPO: dedupe((graph.publicCompaniesDependingOnIPO || []).map(edge => normalizeEdge(edge, 'inbound'))),
    publicCompaniesIPOCompanyDependsOn: dedupe((graph.publicCompaniesIPOCompanyDependsOn || []).map(edge => normalizeEdge(edge, 'outbound'))),
  };
}
function normalizeDependencyIngestion(value = {}) {
  if (!value || typeof value !== 'object' || !value.attemptedAt) return null;
  const attemptedAt = new Date(value.attemptedAt);
  if (!Number.isFinite(attemptedAt.getTime())) return null;
  return {
    parserVersion: cleanText(value.parserVersion) || null,
    attemptedAt: attemptedAt.toISOString(),
    status: ['complete', 'no_evidence', 'no_sec_source', 'partial_error', 'fetch_failed'].includes(value.status) ? value.status : 'no_evidence',
    sourceUrlsFound: Math.max(0, Number(value.sourceUrlsFound) || 0),
    sourceUrlsAttempted: Math.max(0, Number(value.sourceUrlsAttempted) || 0),
    edgesFound: Math.max(0, Number(value.edgesFound) || 0),
    errors: (Array.isArray(value.errors) ? value.errors : []).map(cleanText).filter(Boolean).slice(0, 3),
  };
}
function statusFromLifecycle(record, now = new Date()) {
  const explicit = { s1: 'filed', expected: record.filingType ? 'filed' : 'unknown' }[record.status] || record.status;
  const verifiedListing = record.ipoDate && record.ticker && record.exchange && (record.sources || []).some(source =>
    ['exchange', 'company'].includes(source.type) && Number(source.confidence) >= 0.75);
  if (verifiedListing && (explicit === 'completed' || explicit === 'listed')) return explicit;
  const lifecycle = record.lifecycleFilings?.length ? record.lifecycleFilings : (record.sources || []).map(source => ({
    form: cleanText(source.title).match(/\b(S-1\/A|S-1|F-1\/A|F-1|424B4|424B1|EFFECT|RW WD|RW)\s*$/i)?.[1],
    date: source.date,
  }));
  const forms = lifecycle.map(item => ({ form: cleanText(item.form || item.filingType).toUpperCase(), date: isoDate(item.date || item.filingDate) }))
    .filter(item => item.form).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const latest = forms[0];
  if (latest && WITHDRAWAL_FORMS.has(latest.form)) return 'withdrawn';
  if (forms.some(item => FINAL_FORMS.has(item.form))) return 'completed';
  if (latest?.form === 'S-1/A' || latest?.form === 'F-1/A') return 'amended';
  if (latest?.form === 'S-1' || latest?.form === 'F-1') return 'filed';

  const legacy = explicit;
  let status = VALID_STATUSES.has(legacy) ? legacy : 'unknown';
  if ((status === 'completed' || status === 'listed') && !(record.ipoDate && record.ticker && record.exchange &&
      (record.sources || []).some(source => ['exchange', 'company'].includes(source.type) && Number(source.confidence) >= 0.75))) {
    status = 'unknown';
  }
  if ((status === 'rumored' || status === 'private') && !(record.sources || []).some(source =>
    ['exchange', 'company', 'news'].includes(source.type) && Number(source.confidence) >= 0.75)) status = 'unknown';
  const evidenceDate = isoDate(record.latestUpdateDate || record.filingDate);
  if (ACTIVE_STATUSES.has(status) && evidenceDate) {
    const ageDays = Math.floor((now - new Date(`${evidenceDate}T00:00:00Z`)) / 86400000);
    if (ageDays > 730) status = 'unknown';
  }
  return status;
}
function statusLabel(status) {
  return ({ rumored: 'Rumored', filed: 'Filed', amended: 'Amended', priced: 'Priced', listed: 'Listed', withdrawn: 'Withdrawn', delayed: 'Delayed', completed: 'Completed', private: 'Private', unknown: 'Needs verification' })[status] || 'Needs verification';
}
function normalizeRecord(record, options = {}) {
  const legalName = cleanText(record.legalName || record.name).replace(/\s*\(CIK\s+\d+\)\s*$/i, '');
  const name = cleanText(record.name || legalName).replace(/\s*\([^)]*(?:CIK\s+\d+|SPCX)\)\s*$/i, '') || legalName;
  const sources = (Array.isArray(record.sources) ? record.sources : sourceFromRecord(record)).map(normalizeSource).filter(Boolean);
  const latestSourceDate = sources.map(source => source.date).filter(Boolean).sort().pop() || null;
  const filingDate = isoDate(record.filingDate);
  const latestUpdateDate = isoDate(record.latestUpdateDate) || latestSourceDate || filingDate || options.today || new Date().toISOString().slice(0, 10);
  const status = statusFromLifecycle({ ...record, sources, latestUpdateDate }, options.now || new Date());
  const cik = cleanText(record.cik).replace(/^0+/, '') || null;
  const normalized = {
    id: record.id || stableId({ ...record, legalName, name, cik }),
    slug: slugify(record.slug || name), name, legalName,
    sector: cleanText(record.sector || 'Other'), industry: cleanText(record.industry) || null,
    valuation: cleanText(record.valuation) && record.valuation !== '—' ? cleanText(record.valuation) : null,
    valuationNum: valuationNumber(record.valuationNum ?? record.valuation),
    status, statusLabel: statusLabel(status), exchange: normalizeExchange(record.exchange),
    ticker: cleanText(record.ticker) || null, expected: cleanText(record.expected) && !/unknown|—/i.test(record.expected) ? cleanText(record.expected) : null,
    ipoDate: isoDate(record.ipoDate), filingDate, latestUpdateDate,
    filingType: cleanText(record.filingType) || null, cik,
    sourceUrl: String(record.sourceUrl || sources[0]?.url || ''),
    source: cleanText(record.source || sources[0]?.publisher || 'SEC'), sources,
    notes: cleanText(record.notes), tags: [...new Set((record.tags || []).map(cleanText).filter(Boolean))],
    dependencyGraph: normalizeGraph(record.dependencyGraph),
    dependencyIngestion: normalizeDependencyIngestion(record.dependencyIngestion),
  };
  if ((status === 'completed' || status === 'listed') && !normalized.ipoDate) normalized.ipoDate = latestSourceDate || filingDate;
  return normalized;
}
function recordKey(record) { return record.cik ? `cik:${String(record.cik).replace(/^0+/, '')}` : `name:${normalizedName(record.legalName || record.name)}`; }
function recordScore(record) {
  const formWeight = FINAL_FORMS.has(String(record.filingType || '').toUpperCase()) ? 20 : /\/A$/.test(record.filingType || '') ? 10 : 5;
  return formWeight + (record.ticker ? 10 : 0) + (record.exchange ? 5 : 0) + (record.sources?.length || 0) + Number(String(record.latestUpdateDate || '').replace(/-/g, '').slice(0, 8) || 0) / 1e8;
}
function dedupeRecords(records) {
  const winners = new Map();
  for (const record of records) {
    const normalized = normalizeRecord(record);
    const key = recordKey(normalized);
    const current = winners.get(key);
    if (!current) { winners.set(key, normalized); continue; }
    const winner = recordScore(normalized) > recordScore(current) ? normalized : current;
    const other = winner === normalized ? current : normalized;
    const winnerEdges = (winner.dependencyGraph?.publicCompaniesDependingOnIPO?.length || 0) + (winner.dependencyGraph?.publicCompaniesIPOCompanyDependsOn?.length || 0);
    const otherEdges = (other.dependencyGraph?.publicCompaniesDependingOnIPO?.length || 0) + (other.dependencyGraph?.publicCompaniesIPOCompanyDependsOn?.length || 0);
    if (!winnerEdges && otherEdges) winner.dependencyGraph = other.dependencyGraph;
    if (!winner.dependencyIngestion || String(other.dependencyIngestion?.attemptedAt || '') > String(winner.dependencyIngestion.attemptedAt || '')) winner.dependencyIngestion = other.dependencyIngestion;
    winners.set(key, winner);
  }
  const slugs = new Map();
  return [...winners.values()].map(record => {
    const count = slugs.get(record.slug) || 0; slugs.set(record.slug, count + 1);
    return count ? { ...record, slug: `${record.slug}-${record.cik || count + 1}` } : record;
  });
}
function applyOverrides(records, overrides = []) {
  const normalizedOverrides = overrides.map(record => normalizeRecord(record));
  const overrideKeys = new Set(normalizedOverrides.map(recordKey));
  return dedupeRecords(records.filter(record => !overrideKeys.has(recordKey(normalizeRecord(record)))).concat(normalizedOverrides));
}
function isActive(record) { return ACTIVE_STATUSES.has(record.status); }

module.exports = { VALID_STATUSES, ACTIVE_STATUSES, slugify, normalizedName, stableId, valuationNumber,
  normalizeSource, normalizeEdge, normalizeGraph, normalizeDependencyIngestion, statusFromLifecycle, statusLabel, normalizeRecord,
  recordKey, dedupeRecords, applyOverrides, isActive };
