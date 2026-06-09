#!/usr/bin/env node
/*
  mergers.news — fetch-ipos.js
  Fetches S-1 IPO filings from SEC EDGAR and pushes ipos.json to mawire-db.
  ipo.html will load this file dynamically to show more companies.

  Usage:
    GITHUB_TOKEN=ghp_xxx node fetch-ipos.js

  Cost: $0 — SEC EDGAR full-text search API is completely free.
  Rate limit: ~10 req/s per SEC guidelines. Script sleeps between calls.
*/

'use strict';

const https        = require('https');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'PASTE_YOUR_GITHUB_TOKEN_HERE';
const GITHUB_OWNER = 'realfrantheman';
const GITHUB_REPO  = 'mawire-db';
const GITHUB_FILE  = 'ipos.json';

// ── HTTP HELPER ───────────────────────────────────────────
function get(url, asText) {
  return new Promise(function(resolve, reject) {
    https.get(url, {
      headers: {
        'User-Agent': 'mergers.news/ipos contact@mergers.news',
        'Accept': asText ? 'text/html,text/plain' : 'application/json'
      }
    }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location, asText).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (asText) return resolve(data);
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject)
      .setTimeout(20000, function() { reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function extractName(display_names) {
  var raw = Array.isArray(display_names) ? display_names[0] : (display_names || '');
  return raw.replace(/\s*\(CIK\s+\d+\)\s*$/i, '').trim();
}
function extractCIK(display_names) {
  var raw = Array.isArray(display_names) ? display_names[0] : (display_names || '');
  var m = raw.match(/CIK\s+0*(\d+)/i);
  return m ? m[1] : '';
}

// ── SIC → SECTOR ─────────────────────────────────────────
function normaliseSIC(sics) {
  if (!sics || !sics.length) return 'Technology';
  var s = parseInt(sics[0]);
  if (s >= 7370 && s <= 7379) return 'Technology';
  if (s >= 3559 && s <= 3679) return 'Technology';
  if (s >= 4800 && s <= 4899) return 'Telecommunications';
  if (s >= 4900 && s <= 4999) return 'Energy';
  if (s >= 2800 && s <= 2899) return 'Healthcare';
  if (s >= 8000 && s <= 8099) return 'Healthcare';
  if (s >= 6000 && s <= 6499) return 'Fintech';
  if (s >= 6500 && s <= 6599) return 'Real Estate';
  if (s >= 5000 && s <= 5999) return 'Consumer';
  if (s >= 2000 && s <= 2199) return 'Consumer';
  return 'Technology';
}

function sectorToTag(sector) {
  var map = {
    'Technology': 'tech', 'Telecommunications': 'tech',
    'Healthcare': 'tech', 'Fintech': 'fintech',
    'Consumer': 'consumer', 'Real Estate': 'consumer',
    'Energy': 'tech', 'Industrials': 'tech'
  };
  return map[sector] || 'tech';
}

// ── PARSE OFFERING SIZE FROM S-1 TEXT ────────────────────
function parseOffering(text) {
  if (!text) return null;
  var candidates = [];

  var bPatterns = [
    /aggregate(?:\s+\w+){0,4}\s+\$([\d,]+(?:\.\d+)?)\s*billion/gi,
    /total\s+(?:gross\s+)?proceeds\s+of\s+(?:approximately\s+)?\$([\d,]+(?:\.\d+)?)\s*billion/gi,
    /offering\s+of\s+(?:up\s+to\s+)?(?:approximately\s+)?\$([\d,]+(?:\.\d+)?)\s*billion/gi,
    /\$([\d,]+(?:\.\d+)?)\s*billion\s+(?:in\s+)?(?:gross\s+)?proceeds/gi,
  ];
  var mPatterns = [
    /aggregate(?:\s+\w+){0,4}\s+\$([\d,]+(?:\.\d+)?)\s*million/gi,
    /total\s+(?:gross\s+)?proceeds\s+of\s+(?:approximately\s+)?\$([\d,]+(?:\.\d+)?)\s*million/gi,
    /offering\s+of\s+(?:up\s+to\s+)?(?:approximately\s+)?\$([\d,]+(?:\.\d+)?)\s*million/gi,
    /\$([\d,]+(?:\.\d+)?)\s*million\s+(?:in\s+)?(?:gross\s+)?proceeds/gi,
    /maximum\s+aggregate\s+offering\s+price[^$]*\$([\d,]+(?:\.\d+)?)\s*million/gi,
  ];

  bPatterns.forEach(function(p) {
    p.lastIndex = 0;
    var m;
    while ((m = p.exec(text)) !== null) {
      var v = parseFloat(m[1].replace(/,/g, '')) * 1000;
      if (!isNaN(v) && v >= 10 && v < 500000) candidates.push(v);
    }
  });
  mPatterns.forEach(function(p) {
    p.lastIndex = 0;
    var m;
    while ((m = p.exec(text)) !== null) {
      var v = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(v) && v >= 1 && v < 500000) candidates.push(v);
    }
  });

  if (!candidates.length) return null;
  var best = Math.max.apply(null, candidates);
  if (best >= 1000) return '$' + (best / 1000).toFixed(1).replace('.0', '') + 'B';
  return '$' + Math.round(best) + 'M';
}

// ── PARSE EXCHANGE FROM S-1 TEXT ─────────────────────────
function parseExchange(text) {
  if (!text) return '—';
  if (/nasdaq\s+global\s+select/i.test(text)) return 'NASDAQ';
  if (/nasdaq/i.test(text)) return 'NASDAQ';
  if (/new\s+york\s+stock\s+exchange|nyse/i.test(text)) return 'NYSE';
  if (/nyse\s+american/i.test(text)) return 'NYSE American';
  return '—';
}

// ── PARSE BUSINESS DESCRIPTION FROM S-1 ──────────────────
function parseDescription(text, companyName) {
  if (!text) return companyName + ' filed an S-1 registration statement with the SEC.';

  // Look for "We are a ..." or "Company is a ..." type sentences
  var patterns = [
    new RegExp('We\\s+are\\s+(?:a|an|the)\\s+[^.]{20,200}\\.', 'i'),
    new RegExp(companyName.replace(/[^a-zA-Z0-9 ]/g, '.') + '\\s+is\\s+(?:a|an|the)\\s+[^.]{20,200}\\.', 'i'),
    /Our\s+(?:company|business)\s+(?:is|provides|develops|offers)\s+[^.]{20,200}\./i,
    /(?:provider|developer|manufacturer|operator)\s+of\s+[^.]{20,200}\./i,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[0] && m[0].length > 30 && m[0].length < 300) {
      return m[0].trim().replace(/\s+/g, ' ');
    }
  }

  // Fallback: find first substantive sentence
  var sentences = text.replace(/\s+/g, ' ').match(/[A-Z][^.!?]{40,200}[.!?]/g) || [];
  for (var j = 0; j < Math.min(sentences.length, 20); j++) {
    var s = sentences[j].trim();
    if (s.indexOf(companyName) !== -1 || /company|business|product|service|platform/i.test(s)) {
      if (s.length > 40 && s.length < 300) return s;
    }
  }

  return companyName + ' filed an S-1 registration statement with the SEC seeking to list on a U.S. exchange.';
}

// ── DETERMINE IPO STATUS FROM FILING TYPE ────────────────
function determineStatus(formType, filingDate) {
  var yr = parseInt((filingDate || '').slice(0, 4));
  var now = new Date().getFullYear();
  if (formType === 'S-1/A') return { status: 'expected', label: 'S-1 Filed' };
  if (formType === 'S-1')   return { status: 's1',       label: 'S-1 Filed' };
  if (yr < now - 1)         return { status: 'completed', label: 'Completed' };
  return { status: 's1', label: 'S-1 Filed' };
}

// ── FETCH S-1 DOCUMENT TEXT ───────────────────────────────
async function fetchS1Text(cik, hitId) {
  if (!cik || !hitId) return '';
  try {
    var parts     = hitId.split(':');
    var accPart   = parts[0] || '';
    var fileName  = parts[1] || '';
    var accNoDash = accPart.replace(/-/g, '');
    if (!accNoDash) return '';

    var url;
    if (fileName) {
      url = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/' + fileName;
    } else {
      var accFormatted = accNoDash.slice(0,10) + '-' + accNoDash.slice(10,12) + '-' + accNoDash.slice(12);
      var idx = await get('https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/' + accFormatted + '-index.htm', true);
      var docMatch = idx.match(/href="(\/Archives\/edgar\/data\/[^"]+\.htm)"/i);
      if (!docMatch) return '';
      url = 'https://www.sec.gov' + docMatch[1];
    }

    var html = await get(url, true);
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40000);
  } catch(e) {
    return '';
  }
}

// ── BUILD IPO COMPANY OBJECT ──────────────────────────────
async function buildIPO(hit, formType, fetchText) {
  var src  = hit._source || {};
  var name = extractName(src.display_names);
  var cik  = extractCIK(src.display_names) || src.entity_id || '';
  var date = (src.file_date || '').slice(0, 10);

  if (!name || name.length < 2) return null;

  var sector  = normaliseSIC(src.sics);
  var tag     = sectorToTag(sector);
  var st      = determineStatus(formType, date);
  var yr      = (date || '').slice(0, 4);
  var expected = yr ? yr : '2025-2026';

  var text        = fetchText !== false ? await fetchS1Text(cik, hit._id || '') : '';
  var valuation   = parseOffering(text) || '—';
  var exchange    = parseExchange(text);
  var description = parseDescription(text, name);

  // Build source URL
  var parts     = (hit._id || '').split(':');
  var accPart   = parts[0] || '';
  var fileName  = parts[1] || '';
  var accNoDash = accPart.replace(/-/g, '');
  var sourceUrl = '';
  if (cik && accNoDash && fileName) {
    sourceUrl = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/' + fileName;
  } else if (cik && accNoDash) {
    var accFormatted = accNoDash.slice(0,10) + '-' + accNoDash.slice(10,12) + '-' + accNoDash.slice(12);
    sourceUrl = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/' + accFormatted + '-index.htm';
  }

  return {
    name:        name,
    sector:      sector,
    valuation:   valuation,
    status:      st.status,
    statusLabel: st.label,
    exchange:    exchange,
    expected:    expected,
    notes:       description,
    tags:        [tag],
    cik:         cik,
    filingDate:  date,
    filingType:  formType,
    sourceUrl:   sourceUrl,
    source:      'SEC EDGAR'
  };
}

// ── EDGAR FULL-TEXT SEARCH ────────────────────────────────
async function edgarSearch(form, startDt, endDt, from) {
  var url = 'https://efts.sec.gov/LATEST/search-index' +
    '?q=' + encodeURIComponent('"initial public offering" OR "IPO"') +
    '&forms=' + encodeURIComponent(form) +
    '&dateRange=custom&startdt=' + startDt + '&enddt=' + endDt +
    '&from=' + (from || 0);
  try {
    var res = await get(url);
    return (res.hits && res.hits.hits) ? res.hits.hits : [];
  } catch(e) {
    console.log('  EDGAR error:', e.message);
    return [];
  }
}

// ── FETCH ALL S-1 FILINGS ─────────────────────────────────
async function fetchAllS1s() {
  var ipos = [];
  // Expanded to 8 years; each 2-year window keeps per-query hit counts manageable
  var periods = [
    ['2025-01-01', '2026-12-31'],
    ['2023-01-01', '2024-12-31'],
    ['2021-01-01', '2022-12-31'],
    ['2019-01-01', '2020-12-31'],
  ];
  // S-1/S-1/A: US domestic IPOs
  // F-1/F-1/A: Foreign private issuers (UK, EU, Asia, LatAm listing in US)
  var forms = ['S-1', 'S-1/A', 'F-1', 'F-1/A'];
  var MAX_IPOS = 1200;
  var nowYear  = new Date().getFullYear();

  outer:
  for (var f = 0; f < forms.length; f++) {
    var form = forms[f];
    for (var p = 0; p < periods.length; p++) {
      var start = periods[p][0], end = periods[p][1];
      console.log('[EDGAR] ' + form + ' ' + start.slice(0,4) + '-' + end.slice(0,4) + '...');

      var pageSize = null; // auto-detected from first response

      for (var from = 0; ; from += (pageSize || 10)) {
        var hits = await edgarSearch(form, start, end, from);
        if (!hits.length) break;

        // Detect actual page size from first response
        if (pageSize === null) pageSize = hits.length;

        var periodYear = parseInt(end.slice(0, 4));
        var fetchText  = (nowYear - periodYear) < 2; // only fetch full text for recent filings

        for (var i = 0; i < hits.length; i++) {
          try {
            var ipo = await buildIPO(hits[i], form, fetchText);
            if (ipo) { ipos.push(ipo); process.stdout.write('.'); }
          } catch(e) { /* skip */ }
          await sleep(fetchText ? 120 : 50); // lighter rate-limit for metadata-only
        }

        console.log('\n  ' + form + ' ' + start.slice(0,4) + ' from=' + from + ': ' + hits.length + ' hits → ' + ipos.length + ' total');
        await sleep(400);

        if (hits.length < pageSize) break; // last page
        if (ipos.length >= MAX_IPOS) break outer;
      }

      if (ipos.length >= MAX_IPOS) break outer;
    }
  }

  return ipos;
}

// ── DEDUPLICATE ───────────────────────────────────────────
function dedupe(ipos) {
  var seen = new Set();
  return ipos.filter(function(c) {
    // Normalise: lowercase, strip legal suffixes
    var key = c.name.toLowerCase()
      .replace(/\s*(inc\.?|corp\.?|llc\.?|ltd\.?|plc\.?|co\.?|group|holdings?|corporation|company)\s*$/i, '')
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── LOAD EXISTING FROM GITHUB ─────────────────────────────
async function loadExisting() {
  try {
    var url = 'https://raw.githubusercontent.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/main/' + GITHUB_FILE + '?t=' + Date.now();
    var data = await get(url);
    if (Array.isArray(data)) {
      console.log('[GitHub] Loaded', data.length, 'existing IPO entries');
      return data;
    }
  } catch(e) {
    console.log('[GitHub] No existing ipos.json — will create new');
  }
  return [];
}

// ── COMMIT TO GITHUB ──────────────────────────────────────
async function commit(ipos) {
  console.log('\n[GitHub] Committing', ipos.length, 'IPO entries...');

  var sha = null;
  try {
    var info = await new Promise(function(resolve) {
      https.get('https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_FILE, {
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'mergers.news/ipos',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }, function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
      }).on('error', function() { resolve({}); });
    });
    sha = info.sha || null;
    console.log('[GitHub] SHA:', sha ? sha.slice(0, 8) : 'new file');
  } catch(e) {}

  var payload = JSON.stringify({
    message: 'IPO data: ' + ipos.length + ' companies from EDGAR S-1 filings',
    content: Buffer.from(JSON.stringify(ipos, null, 2)).toString('base64'),
    ...(sha ? { sha } : {})
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_FILE,
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'mergers.news/ipos',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log('[GitHub] ✓ Committed', ipos.length, 'IPO entries');
          resolve(ipos.length);
        } else {
          console.error('[GitHub] Error', res.statusCode, d.slice(0, 200));
          reject(new Error('HTTP ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('mergers.news — IPO Data Fetcher');
  console.log('Source: SEC EDGAR S-1 filings (completely free)');
  console.log('Output: ipos.json pushed to mawire-db');
  console.log('='.repeat(60));

  if (GITHUB_TOKEN === 'PASTE_YOUR_GITHUB_TOKEN_HERE') {
    console.error('\n❌  Set your token: GITHUB_TOKEN=ghp_xxx node fetch-ipos.js\n');
    process.exit(1);
  }

  var existing = await loadExisting();
  var fetched  = await fetchAllS1s();
  console.log('\n[Fetched] Raw S-1 filings:', fetched.length);

  // Merge: keep existing entries, add new ones not already present
  var existingNames = new Set(existing.map(function(c) {
    return c.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  }));
  var newEntries = fetched.filter(function(c) {
    var key = c.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    return !existingNames.has(key);
  });

  var merged = dedupe(existing.concat(newEntries));

  // Sort: S-1 filed first, then expected, then by filing date desc
  var order = { s1: 0, expected: 1, rumored: 2, completed: 3 };
  merged.sort(function(a, b) {
    var os = (order[a.status] || 0) - (order[b.status] || 0);
    if (os !== 0) return os;
    return (b.filingDate || '').localeCompare(a.filingDate || '');
  });

  console.log('[Merged] Existing:', existing.length, '| New:', newEntries.length, '| Total:', merged.length);
  await commit(merged);

  console.log('\n✓ Done. ipos.json is now live at:');
  console.log('  https://raw.githubusercontent.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/main/ipos.json');
  console.log('\nNow update ipo.html to load this file dynamically (see instructions).');
}

main().catch(function(e) { console.error('Fatal:', e.message); process.exit(1); });
