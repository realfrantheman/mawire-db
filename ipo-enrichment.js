'use strict';

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function plainText(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function moneyNumber(amount, scale) {
  const value = Number(String(amount || '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const unit = String(scale || '').toLowerCase();
  return value * (unit === 'billion' ? 1e9 : unit === 'million' ? 1e6 : unit === 'thousand' ? 1e3 : 1);
}
function humanMoney(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(value >= 100e6 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (value >= 1e3) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function sharesNumber(value) {
  const number = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(number) && number >= 1000 ? number : null;
}
function humanShares(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString('en-US');
}
function normalizeExchange(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/nasdaq/i.test(text)) return 'Nasdaq';
  if (/nyse american/i.test(text)) return 'NYSE American';
  if (/new york stock exchange|\bnyse\b/i.test(text)) return 'NYSE';
  return text;
}
function parsePriceRange(plain) {
  const patterns = [
    /(?:initial public offering|public offering|offering)[\s\S]{0,220}?(?:price|priced)[^$]{0,100}\$\s*([\d,.]+)\s*(?:to|and|–|—|-)\s*\$\s*([\d,.]+)\s*(?:per\s+(?:share|ordinary share|american depositary share|ads)|a\s+share)/i,
    /(?:between|from)\s*\$\s*([\d,.]+)\s*(?:and|to|–|—|-)\s*\$\s*([\d,.]+)\s*(?:per\s+(?:share|ordinary share|american depositary share|ads)|a\s+share)/i,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (!match) continue;
    const low = Number(match[1].replace(/,/g, ''));
    const high = Number(match[2].replace(/,/g, ''));
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > 100000) continue;
    const format = value => Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '');
    return `$${format(low)}–$${format(high)}/share`;
  }
  return null;
}
function parseSharesOffered(plain) {
  const patterns = [
    /\bwe\s+are\s+offering\s+([\d,]{4,})\s+(?:shares|ordinary shares|common shares|american depositary shares|ADSs)\b/i,
    /\boffering\s+of\s+([\d,]{4,})\s+(?:shares|ordinary shares|common shares|american depositary shares|ADSs)\b/i,
    /\b([\d,]{4,})\s+(?:shares|ordinary shares|common shares|american depositary shares|ADSs)\s+(?:are|is)\s+being\s+offered\b/i,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    const number = sharesNumber(match && match[1]);
    if (number) return { sharesOfferedNum: number, sharesOffered: humanShares(number) };
  }
  return { sharesOfferedNum: null, sharesOffered: null };
}
function parseOfferingSize(plain) {
  const patterns = [
    /\b(?:aggregate offering price|total offering amount|size of (?:this|the) offering)\b[^$]{0,90}\$\s*([\d,.]+)\s*(billion|million|thousand)?/i,
    /\b(?:gross proceeds from (?:this|the) offering)\b[^$]{0,90}\$\s*([\d,.]+)\s*(billion|million|thousand)?/i,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (!match) continue;
    const value = moneyNumber(match[1], match[2]);
    if (Number.isFinite(value) && value >= 100000) return { offeringSizeNum: value, offeringSize: humanMoney(value) };
  }
  return { offeringSizeNum: null, offeringSize: null };
}
function parseTextMetadata(text) {
  const plain = plainText(text);
  const tickerMatch = plain.match(/(?:ticker|trading|symbol)\s+(?:symbol\s+)?[“"']?([A-Z][A-Z0-9.]{0,5})[”"']?/i)?.[1] || null;
  const ticker = tickerMatch ? tickerMatch.replace(/\.$/, '') : null;
  const exchange = /nasdaq/i.test(plain) ? 'Nasdaq' : /nyse american/i.test(plain) ? 'NYSE American' : /new york stock exchange|\bnyse\b/i.test(plain) ? 'NYSE' : null;
  const shares = parseSharesOffered(plain);
  const offering = parseOfferingSize(plain);
  return { ticker, exchange, priceRange: parsePriceRange(plain), ...shares, ...offering };
}
function formatHeadquarters(address) {
  if (!address || typeof address !== 'object') return null;
  const parts = [address.street1, address.street2, address.city, address.stateOrCountry, address.zipCode]
    .map(cleanText).filter(Boolean);
  return [...new Set(parts)].join(', ') || null;
}
function parseSubmissionMetadata(payload = {}) {
  const tickers = Array.isArray(payload.tickers) ? payload.tickers.filter(Boolean) : [];
  const exchanges = Array.isArray(payload.exchanges) ? payload.exchanges.filter(Boolean) : [];
  return {
    ticker: cleanText(tickers[0]) || null,
    exchange: normalizeExchange(exchanges[0]),
    industry: cleanText(payload.sicDescription) || null,
    headquarters: formatHeadquarters(payload.addresses && payload.addresses.business),
  };
}

module.exports = {
  plainText, moneyNumber, humanMoney, parsePriceRange, parseSharesOffered, parseOfferingSize,
  parseTextMetadata, formatHeadquarters, parseSubmissionMetadata,
};
