'use strict';

const crypto = require('crypto');

const PARSER_VERSION = 'rules-v4.0';
const PLACEHOLDER_RE = /^(?:unknown|undisclosed(?: buyer| acquirer| target)?|n\/a|null|none|tbd)$|see filing|disclosed in filing/i;
const NAME = "([A-Z][A-Za-z0-9&.,'\\- ]{1,120}?)";
const END = '(?=\\s+(?:for|from|in a|in an|valued|at a value|under the terms)|[.;]|$)';

const PARTY_PATTERNS = [
  { acquirer: 1, target: 2, confidence: 0.84, re: new RegExp(`(?:consortium|group)\\s+(?:led|backed)\\s+by\\s+${NAME}\\s+(?:will|to|has agreed to)\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.92, re: new RegExp(`${NAME}\\s+(?:has\\s+)?(?:agreed|entered into an agreement)\\s+to\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.90, re: new RegExp(`${NAME}\\s+(?:will|to)\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.88, re: new RegExp(`${NAME}\\s+acquires\\s+${NAME}${END}`, 'i') },
  { acquirer: 2, target: 1, confidence: 0.90, re: new RegExp(`${NAME}\\s+(?:to be|was|will be)\\s+acquired\\s+by\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.82, re: new RegExp(`${NAME}\\s+and\\s+${NAME}\\s+(?:agree|agreed|plan)\\s+to\\s+merge`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.78, re: new RegExp(`${NAME}\\s+(?:will|to|agreed to)\\s+merge\\s+with\\s+${NAME}${END}`, 'i') },
];

const SINGLE_PATTERNS = {
  acquirer: [
    new RegExp(`(?:Parent|Buyer|Purchaser|Acquir(?:er|or)|Offeror)\\s*(?:means|is|:|–|-)\\s*${NAME}`, 'i'),
    new RegExp(`to\\s+be\\s+acquired\\s+by\\s+${NAME}`, 'i'),
    new RegExp(`(?:acquisition|purchase)\\s+by\\s+${NAME}`, 'i'),
    new RegExp(`(?:consortium|group)\\s+(?:led|backed)\\s+by\\s+${NAME}`, 'i'),
  ],
  target: [
    new RegExp(`(?:Target|Subject Company|Target Company)\\s*(?:means|is|:|–|-)\\s*${NAME}`, 'i'),
    new RegExp(`(?:acquire|purchase|acquisition of)\\s+${NAME}`, 'i'),
    new RegExp(`tender\\s+offer\\s+for\\s+(?:all\\s+)?(?:shares\\s+of\\s+)?${NAME}`, 'i'),
  ],
};

const CONTROL_RE = /\b(?:agreement and plan of merger|definitive (?:merger )?agreement|business combination agreement|agreed to acquire|agrees to acquire|to be acquired by|will acquire|acquisition of|tender offer (?:to purchase|for) all|offer to purchase all|going[- ]private|take[- ]private|merger with|merge with|scheme of arrangement)\b/i;
const NON_CONTROL_RE = /\b(?:minority investment|minority stake|non-controlling stake|venture funding|series [a-z]|debt financing|credit facility|joint venture|partnership|share buyback|stock buyback|repurchase|initial public offering|ipo)\b/i;

function cleanCompanyName(value) {
  if (!value) return null;
  const name = String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’:,.-]+|[\s"'“”‘’:,.-]+$/g, '')
    .replace(/\s+(?:for|in|under|pursuant|valued|at|which|that|and the)\s+.*$/i, '')
    .trim();
  if (name.length < 2 || name.length > 140 || PLACEHOLDER_RE.test(name)) return null;
  return name;
}

function isReliableName(value) {
  return !!cleanCompanyName(value);
}

function firstReliable(...values) {
  for (const value of values.flat()) {
    const clean = cleanCompanyName(value);
    if (clean) return clean;
  }
  return null;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(?:incorporated|corporation|corp|company|co|limited|ltd|llc|plc|holdings?|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function distinctParties(acquirer, target) {
  return !!(isReliableName(acquirer) && isReliableName(target) && normalizeName(acquirer) !== normalizeName(target));
}

function extractParties(text) {
  const source = String(text || '').replace(/\s+/g, ' ');
  for (const pattern of PARTY_PATTERNS) {
    const match = pattern.re.exec(source);
    if (!match) continue;
    const acquirer = cleanCompanyName(match[pattern.acquirer]);
    const target = cleanCompanyName(match[pattern.target]);
    if (distinctParties(acquirer, target)) {
      return { acquirer, target, confidence: pattern.confidence, method: 'party_pair_pattern' };
    }
  }

  const result = { acquirer: null, target: null, confidence: 0, method: 'single_party_patterns' };
  for (const role of ['acquirer', 'target']) {
    for (const pattern of SINGLE_PATTERNS[role]) {
      const match = pattern.exec(source);
      const name = match && cleanCompanyName(match[1]);
      if (name) {
        result[role] = name;
        result.confidence += 0.35;
        break;
      }
    }
  }
  if (!distinctParties(result.acquirer, result.target) && normalizeName(result.acquirer) === normalizeName(result.target)) {
    result.target = null;
  }
  return result;
}

function rawSnippet(text, maxLength = 2000) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
}

function parseNumber(value) {
  const number = Number.parseFloat(String(value || '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function extractDealValue(text) {
  const source = String(text || '');
  const candidates = [];
  const patterns = [
    { re: /(?:aggregate|total|transaction|deal|merger|purchase)\s+(?:consideration|value|price)\s+(?:of|at|is|was)?\s*(?:approximately\s+)?(?:US\s*)?\$\s*([\d,.]+)\s*(trillion|billion|million|thousand|tn|bn|mm|m|b|t)\b/gi, context: true },
    { re: /(?:valued|value|consideration|purchase price)\s+(?:at|of|is|was)\s+(?:approximately\s+)?(?:US\s*)?\$\s*([\d,.]+)\s*(trillion|billion|million|thousand|tn|bn|mm|m|b|t)\b/gi, context: true },
    { re: /(?:US\s*)?\$\s*([\d,.]+)\s*(trillion|billion|million|tn|bn|mm|m|b|t)\b.{0,80}\b(?:merger|acquisition|transaction|deal|consideration|purchase price)\b/gi, context: true },
  ];
  const multipliers = { trillion: 1e12, tn: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mm: 1e6, m: 1e6, thousand: 1e3 };
  for (const { re } of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) {
      const number = parseNumber(match[1]);
      const multiplier = multipliers[String(match[2] || '').toLowerCase()] || 1;
      const value = number === null ? null : number * multiplier;
      if (value !== null && value >= 1e6 && value < 1e15) candidates.push(value);
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

function extractPerShare(text) {
  const patterns = [
    /\$\s*([\d,.]+)\s*per\s+(?:common\s+|ordinary\s+)?share/i,
    /per\s+(?:common\s+|ordinary\s+)?share\s+(?:consideration\s+of\s+)?\$\s*([\d,.]+)/i,
    /cash\s+consideration\s+of\s+\$\s*([\d,.]+)\s*per\s+share/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    const value = parseNumber(match?.[1]);
    if (value !== null && value > 0 && value < 100000) return value;
  }
  return null;
}

// Stored as a decimal fraction: 25.5% => 0.255.
function extractPremium(text) {
  const patterns = [
    /premium\s+of\s+(?:approximately\s+)?([\d.]+)\s*%/i,
    /([\d.]+)\s*%\s*premium\s+(?:to|over|above)/i,
    /represents\s+(?:a\s+)?(?:approximately\s+)?([\d.]+)\s*%\s*premium/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    const percentage = parseNumber(match?.[1]);
    if (percentage !== null && percentage > 0 && percentage < 500) return percentage / 100;
  }
  return null;
}

function normalizeDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const value = new Date(Date.UTC(y, m - 1, d));
  if (value.getUTCFullYear() !== y || value.getUTCMonth() + 1 !== m || value.getUTCDate() !== d) return null;
  return value.toISOString().slice(0, 10);
}

function extractDates(text) {
  const source = String(text || '');
  const output = [];
  const seen = new Set();
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  let match;
  const word = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  while ((match = word.exec(source)) !== null && output.length < 10) {
    const date = normalizeDate(match[3], months[match[1].toLowerCase()], match[2]);
    if (date && !seen.has(date)) { seen.add(date); output.push(date); }
  }
  const iso = /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/g;
  while ((match = iso.exec(source)) !== null && output.length < 10) {
    const date = normalizeDate(match[1], match[2], match[3]);
    if (date && !seen.has(date)) { seen.add(date); output.push(date); }
  }
  return output.sort();
}

function detectDealType(text, filingType) {
  const source = String(text || '');
  const form = String(filingType || '').toUpperCase();
  if (form.startsWith('SC 13E-3') || /\b(?:going[- ]private|take[- ]private|leveraged buyout|management buyout)\b/i.test(source)) return 'Going-Private';
  if (form.startsWith('SC TO-T') || /\b(?:tender offer|offer to purchase all)\b/i.test(source)) return 'Tender Offer';
  if (/\b(?:sale of (?:the )?(?:business|division|subsidiary|operations)|divestiture|carve[- ]out)\b/i.test(source)) return 'Divestiture';
  if (/\b(?:agreement and plan of merger|merger agreement|business combination agreement|merge with|merger with|scheme of arrangement)\b/i.test(source)) return 'Merger';
  if (/\b(?:agreed to acquire|agrees to acquire|will acquire|acquisition of|purchase of)\b/i.test(source)) return 'Acquisition';
  return null;
}

function extractSeller(text) {
  const patterns = [
    new RegExp(`(?:sold|sale)\\s+(?:by|from)\\s+${NAME}`, 'i'),
    new RegExp(`Seller\\s*(?:means|is|:|–|-)\\s*${NAME}`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    const seller = cleanCompanyName(match?.[1]);
    if (seller) return seller;
  }
  return null;
}

function evidenceExcerpt(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const match = CONTROL_RE.exec(source);
  if (!match) return source.slice(0, 1200) || null;
  return source.slice(Math.max(0, match.index - 300), Math.min(source.length, match.index + 900));
}

function extractDeal(text, options = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const filingType = String(options.filingType || '').toUpperCase();
  const parties = extractParties(source);
  let acquirer = parties.acquirer;
  let target = parties.target;

  // Use a supplied issuer only when its filing role is structurally clear.
  // Generic/news extraction never assigns roles from the issuer option.
  const issuer = cleanCompanyName(options.issuer || options.companyName);
  if (issuer) {
    if (['DEFM14A', 'PREM14A', 'DEFA14A'].includes(filingType)) target = target || issuer;
    else if (['S-4', 'S-4/A', 'SC TO-T', 'SC TO-T/A'].includes(filingType)) acquirer = acquirer || issuer;
    else if (['SC 13E-3', 'SC 13E-3/A'].includes(filingType)) target = target || issuer;
  }

  acquirer = cleanCompanyName(acquirer);
  target = cleanCompanyName(target);
  if (!distinctParties(acquirer, target) && normalizeName(acquirer) === normalizeName(target)) {
    // In SC 13E-3 the filer/issuer is usually the subject company, not proof
    // of the buyer. Never create a same-party control transaction.
    acquirer = filingType.startsWith('SC 13E-3') ? null : acquirer;
    if (normalizeName(acquirer) === normalizeName(target)) target = null;
  }

  const hasControlEvidence = CONTROL_RE.test(source) && !NON_CONTROL_RE.test(source.slice(0, 2500));
  const dealType = detectDealType(source, filingType);
  const value = extractDealValue(source);
  const perShare = extractPerShare(source);
  const premium = extractPremium(source);
  const dates = extractDates(source);
  const seller = extractSeller(source);
  const completeParties = distinctParties(acquirer, target);
  const sourceReliability = Math.max(0, Math.min(20, Number(options.sourceReliability ?? 10)));
  const dedupCertainty = Math.max(0, Math.min(5, Number(options.dedupCertainty ?? 0)));

  const components = {
    parties: completeParties ? 35 : (acquirer || target ? 15 : 0),
    controlEvidence: hasControlEvidence ? 25 : 0,
    transactionType: dealType ? 10 : 0,
    financialTerms: value || perShare ? 5 : 0,
    sourceReliability,
    dedupCertainty,
  };
  const rawScore = Object.values(components).reduce((sum, component) => sum + component, 0);
  const confidence = Math.max(parties.confidence || 0, Math.min(0.99, rawScore / 100));

  let disposition = 'review';
  let reviewReason = null;
  const reviewLabels = [];
  if (!hasControlEvidence) reviewLabels.push('control_evidence_missing');
  if (!completeParties) reviewLabels.push('party_resolution_incomplete');
  if (!dealType) reviewLabels.push('transaction_type_unresolved');
  if (completeParties && hasControlEvidence && dealType && confidence >= 0.75) disposition = 'candidate';
  else if (!hasControlEvidence && !acquirer && !target) disposition = 'rejected';
  reviewReason = reviewLabels[0] || null;

  const snippet = evidenceExcerpt(source);
  return {
    acquirer,
    target,
    seller,
    value,
    perShare,
    premium,
    dealType,
    dates,
    confidence,
    score: { total: rawScore, components },
    evidenceSnippet: snippet,
    evidenceHash: snippet ? crypto.createHash('sha256').update(snippet).digest('hex') : null,
    parserVersion: PARSER_VERSION,
    reviewReason,
    reviewLabels,
    disposition,
    roles: { acquirer, target, seller },
  };
}

async function withRetry(operation, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs || 500;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const retryAfter = Number(error?.retryAfterMs) || 0;
      await new Promise(resolve => setTimeout(resolve, Math.max(retryAfter, baseDelayMs * (2 ** (attempt - 1)))));
    }
  }
  throw lastError;
}

module.exports = {
  PARSER_VERSION,
  PLACEHOLDER_RE,
  cleanCompanyName,
  isReliableName,
  firstReliable,
  normalizeName,
  distinctParties,
  extractParties,
  extractDeal,
  extractDealValue,
  extractPerShare,
  extractPremium,
  extractDates,
  detectDealType,
  rawSnippet,
  withRetry,
};
