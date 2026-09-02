'use strict';

const USER_AGENT = 'mergers.news contact@mergers.news';

function cleanHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractAccession(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(\d{10}-\d{2}-\d{6})/);
    if (match) return match[1];
  }
  return null;
}

function normalizeCik(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

/**
 * Build a direct SEC submission URL. The archive owner CIK is not always the
 * first ten digits of the accession (for example, submissions made through a
 * filing agent), so callers should pass the issuer/filer CIK when available.
 */
function secSubmissionUrl(accession, cikOverride = null) {
  const match = String(accession || '').match(/^(\d{10})-(\d{2})-(\d{6})$/);
  if (!match) return null;
  const cik = normalizeCik(cikOverride) || String(parseInt(match[1], 10));
  const folder = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${accession}.txt`;
}

function isDirectSecArchiveFile(value) {
  const url = cleanHttpUrl(value);
  if (!url) return false;
  return /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[^/?#]+/i.test(url) &&
    !/-index\.html(?:[?#]|$)/i.test(url);
}

function canonicalSecDocumentUrl(record = {}) {
  const candidates = [record.documentUrl, record.sourceUrl, record.edgarUrl, record.filingUrl];
  for (const candidate of candidates) {
    if (isDirectSecArchiveFile(candidate)) return cleanHttpUrl(candidate);
  }
  const accession = extractAccession(record.accessionNo, ...candidates);
  return secSubmissionUrl(accession, record.filingCik || record.cik);
}

function isLandingPage(value) {
  const url = cleanHttpUrl(value);
  if (!url) return true;
  return /sec\.gov\/(?:cgi-bin\/browse-edgar|edgar\/browse)|efts\.sec\.gov\/LATEST\/search-index/i.test(url) ||
    /competition-cases\.ec\.europa\.eu\/search(?:[?#]|$)/i.test(url) ||
    /announcements\.asx\.com\.au\/asxannouncements\.asx(?:[?#]|$)/i.test(url) ||
    /sgx\.com\/securities\/company-announcements(?:[?#]|$)/i.test(url) ||
    /\/(?:rss|rssfeed)(?:\/|\?|$)/i.test(url);
}

function canonicalPrimarySourceUrl(record = {}) {
  const sourceType = String(record.sourceType || record.extractionMethod || '').toLowerCase();
  if (sourceType === 'sec_edgar' || sourceType === 'sec_filing' || sourceType.includes('sec')) {
    return canonicalSecDocumentUrl(record);
  }
  for (const candidate of [record.documentUrl, record.sourceUrl, record.edgarUrl]) {
    const url = cleanHttpUrl(candidate);
    if (url && !isLandingPage(url)) return url;
  }
  return null;
}

function extractCanonicalFromHtml(html, baseUrl) {
  if (!html) return null;
  const match = html.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i);
  if (!match) return null;
  try { return new URL(match[1], baseUrl).toString(); } catch { return null; }
}

async function resolvePrimaryHttpUrl(input) {
  const original = cleanHttpUrl(input);
  if (!original || isLandingPage(original)) return null;
  try {
    const response = await fetch(original, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/pdf,text/plain,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404 || response.status === 410) return null;
    const finalUrl = cleanHttpUrl(response.url) || original;
    if (isLandingPage(finalUrl)) return null;
    const type = response.headers.get('content-type') || '';
    const length = Number(response.headers.get('content-length') || 0);
    if (/text\/html/i.test(type) && (!length || length <= 600000)) {
      const html = await response.text();
      const canonical = cleanHttpUrl(extractCanonicalFromHtml(html, finalUrl));
      if (canonical && !isLandingPage(canonical)) return canonical;
    }
    return finalUrl;
  } catch {
    return original;
  }
}

module.exports = {
  cleanHttpUrl,
  extractAccession,
  normalizeCik,
  secSubmissionUrl,
  isDirectSecArchiveFile,
  canonicalSecDocumentUrl,
  canonicalPrimarySourceUrl,
  isLandingPage,
  resolvePrimaryHttpUrl,
};