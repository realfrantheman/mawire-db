'use strict';

const shared = require('../shared/deal-extraction');

const SECTOR_KEYWORDS = {
  Technology: ['software','technology','semiconductor','cloud','saas','artificial intelligence','cybersecurity','data platform','gaming'],
  Healthcare: ['pharmaceutical','biotech','medical','healthcare','therapeutics','diagnostic','hospital','life science','oncology'],
  'Financial Services': ['bank','financial','insurance','asset management','fintech','payment','credit','mortgage','brokerage','wealth'],
  Energy: ['energy','oil','gas','petroleum','pipeline','utility','power','renewable','solar','wind'],
  Consumer: ['retail','consumer','restaurant','food','beverage','apparel','grocery','e-commerce'],
  Industrial: ['manufacturing','industrial','aerospace','defense','automotive','machinery','chemicals','materials','construction'],
  Telecom: ['telecom','telecommunications','wireless','broadband','cable','satellite','carrier'],
  Media: ['media','entertainment','publishing','broadcasting','streaming','studio'],
  'Real Estate': ['real estate','reit','property','realty'],
};

function detectSector(text) {
  const lower = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = lower.match(new RegExp(`\\b${escaped}\\b`, 'g'));
      score += matches?.length || 0;
    }
    if (score > bestScore) {
      best = sector;
      bestScore = score;
    }
  }
  return best;
}

function safeIssuer(value) {
  const cleaned = shared.cleanCompanyName(value);
  if (!cleaned) return null;
  if (/[\/|]/.test(cleaned)) return null;
  if (/\b(?:unknown acquirer|unknown target|tender offer|going-private|merger)\b/i.test(cleaned)) return null;
  return cleaned;
}

function extractDealInfo(text, filingType, companyName, options = {}) {
  if (!text || String(text).trim().length < 50) return null;
  const issuer = safeIssuer(companyName);
  const extraction = shared.extractDeal(text, {
    filingType,
    issuer,
    sourceType: options.sourceType || 'sec_edgar',
    sourceUrl: options.sourceUrl || null,
    sourceReliability: options.sourceReliability ?? 20,
    dedupCertainty: options.dedupCertainty ?? 3,
  });

  const result = {
    acquirer: extraction.acquirer,
    target: extraction.target,
    seller: extraction.seller,
    deal_value_usd: extraction.value,
    per_share_value: extraction.perShare,
    currency: 'USD',
    premium_pct: extraction.premium,
    deal_type: extraction.dealType,
    announcement_date: extraction.dates[0] || null,
    sector: detectSector(extraction.evidenceSnippet || text),
    confidence: extraction.confidence,
    confidence_components: extraction.score.components,
    evidence_snippet: extraction.evidenceSnippet,
    evidence_hash: extraction.evidenceHash,
    extraction_version: extraction.parserVersion,
    review_reason: extraction.reviewReason,
    review_labels: extraction.reviewLabels,
    disposition: extraction.disposition,
    roles: extraction.roles,
    extraction_notes: [`${extraction.parserVersion}:${extraction.disposition}`],
  };

  if (result.acquirer && result.target) result.headline = `${result.acquirer} / ${result.target}`;
  else if (result.acquirer) result.headline = `${result.acquirer} — ${result.deal_type || 'Transaction'}`;
  else if (result.target) result.headline = `${result.target} — ${result.deal_type || 'Transaction'}`;
  else result.headline = null;
  return result;
}

function extractValue(text) { return shared.extractDealValue(text); }
function extractPerShare(text) { return shared.extractPerShare(text); }
function extractPremium(text) { return shared.extractPremium(text); }
function extractDate(text) { return shared.extractDates(text)[0] || null; }
function detectDealType(filingType, text) { return shared.detectDealType(text, filingType); }
function cleanCompanyName(value) { return shared.cleanCompanyName(value); }

async function processBatch(deals, fetchText) {
  const results = [];
  for (const deal of deals) {
    try {
      const text = deal.raw_content || await fetchText(deal.edgar_url, deal.accession_no, deal.cik);
      if (!text) {
        results.push({ id: deal.id, error: 'no_text' });
        continue;
      }
      const extracted = extractDealInfo(String(text).slice(0, 10000), deal.filing_type, deal.entity_name);
      results.push({ id: deal.id, extracted, text_length: String(text).length });
    } catch (error) {
      results.push({ id: deal.id, error: error.message });
    }
  }
  return results;
}

module.exports = {
  extractDealInfo,
  extractValue,
  extractPerShare,
  extractPremium,
  extractDate,
  detectSector,
  detectDealType,
  cleanCompanyName,
  processBatch,
};
