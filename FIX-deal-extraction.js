'use strict';

const PLACEHOLDER_RE = /^(?:unknown|undisclosed(?: buyer| acquirer| target)?|n\/a)$|see filing|disclosed in filing/i;
const NAME = "([A-Z][A-Za-z0-9&.,'\\- ]{1,120}?)";
const END = '(?=\\s+(?:for|from|in a|in an|valued|at a value|under the terms)|[.;]|$)';

const PARTY_PATTERNS = [
  { acquirer: 1, target: 2, confidence: 0.84, re: new RegExp(`(?:consortium|group)\\s+(?:led|backed)\\s+by\\s+${NAME}\\s+(?:will|to|has agreed to)\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.92, re: new RegExp(`${NAME}\\s+(?:has\\s+)?(?:agreed|entered into an agreement)\\s+to\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.9, re: new RegExp(`${NAME}\\s+(?:will|to)\\s+(?:acquire|buy|purchase)\\s+${NAME}${END}`, 'i') },
  { acquirer: 1, target: 2, confidence: 0.88, re: new RegExp(`${NAME}\\s+acquires\\s+${NAME}${END}`, 'i') },
  { acquirer: 2, target: 1, confidence: 0.9, re: new RegExp(`${NAME}\\s+(?:to be|was|will be)\\s+acquired\\s+by\\s+${NAME}${END}`, 'i') },
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

function extractParties(text) {
  const source = String(text || '').replace(/\s+/g, ' ');
  for (const pattern of PARTY_PATTERNS) {
    const match = pattern.re.exec(source);
    if (match) {
      const acquirer = cleanCompanyName(match[pattern.acquirer]);
      const target = cleanCompanyName(match[pattern.target]);
      if (acquirer && target && acquirer.toLowerCase() !== target.toLowerCase()) {
        return { acquirer, target, confidence: pattern.confidence, method: 'party_pair_pattern' };
      }
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
  return result;
}

function rawSnippet(text, maxLength = 2000) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
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
      const retryAfter = Number(error && error.retryAfterMs) || 0;
      await new Promise(resolve => setTimeout(resolve, Math.max(retryAfter, baseDelayMs * (2 ** (attempt - 1)))));
    }
  }
  throw lastError;
}

module.exports = {
  PLACEHOLDER_RE,
  cleanCompanyName,
  isReliableName,
  firstReliable,
  extractParties,
  rawSnippet,
  withRetry,
};
