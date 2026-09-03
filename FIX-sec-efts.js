'use strict';

const https = require('https');

const USER_AGENT = 'mergers.news contact@mergers.news';
const ROOT_FORMS = ['DEFM14A', 'PREM14A', 'DEFA14A', 'SC TO-T', 'S-4', 'SC 13E-3'];
const DEFAULT_LOOKBACK_DAYS = Math.max(1, Math.min(14, Number(process.env.LOOKBACK_DAYS || process.env.FILE_REFRESH_LOOKBACK_DAYS || 3)));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanAccession(value) {
  return String(value || '').split(':')[0].trim();
}

function normalizeRootForm(value) {
  return String(value || '').trim().replace(/\/A$/i, '');
}

function cleanDisplayName(value) {
  let name = String(value || '').trim();
  name = name.replace(/\s+\(CIK\s+\d{1,10}\)\s*$/i, '');
  name = name.replace(/\s+\([^()]{1,24}\)\s*$/, '');
  return name.trim() || 'Unknown';
}

function cikFromDisplayName(value) {
  const match = String(value || '').match(/\(CIK\s+(\d{1,10})\)/i);
  return match ? match[1] : '';
}

function normalizeCik(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function accessionPrefixCik(value) {
  const match = cleanAccession(value).match(/^(\d{10})-\d{2}-\d{6}$/);
  return match ? normalizeCik(match[1]) : '';
}

function buildEdgarUrl(hitId, cik) {
  const parts = String(hitId || '').split(':');
  const accession = cleanAccession(parts[0]);
  const filename = parts.slice(1).join(':');
  const folder = accession.replace(/-/g, '');
  if (!cik || !folder || !filename) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${filename}`;
}

function buildSearchUrl(filingType, startdt, enddt, from = 0) {
  const rootForm = normalizeRootForm(filingType);
  if (!rootForm || !/^\d{4}-\d{2}-\d{2}$/.test(startdt) || !/^\d{4}-\d{2}-\d{2}$/.test(enddt)) {
    throw new Error('SEC EFTS search requires a root form and explicit YYYY-MM-DD start/end dates');
  }
  const params = new URLSearchParams({
    forms: rootForm,
    dateRange: 'custom',
    startdt,
    enddt,
    from: String(Math.max(0, Number(from) || 0)),
    size: '100',
    'hits.hits.total.value': 'true',
  });
  return `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
}

function hitToFiling(hit) {
  const source = hit?._source || {};
  const displayName = Array.isArray(source.display_names) ? source.display_names[0] : source.display_names;
  const ciks = Array.isArray(source.ciks) ? source.ciks : [];
  const cik = normalizeCik(ciks.find(Boolean) || source.cik || source.entity_id || cikFromDisplayName(displayName))
    || accessionPrefixCik(source.adsh || hit?._id);
  const accession = cleanAccession(source.adsh || hit?._id);
  return {
    id: hit?._id || accession,
    accession_no: accession,
    entity_name: cleanDisplayName(source.entity_name || displayName),
    cik,
    filing_type: source.form || null,
    root_form: Array.isArray(source.root_forms) ? source.root_forms[0] || null : source.root_forms || null,
    filing_date: source.file_date || source.period_ending || source.period_of_report || null,
    filing_url: buildEdgarUrl(hit?._id, cik),
    raw: source,
  };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`SEC EFTS HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 25 * 1024 * 1024) {
          req.destroy(new Error('SEC EFTS response exceeded 25MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`Invalid SEC EFTS JSON: ${error.message}`));
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`SEC EFTS timeout: ${url}`)));
  });
}

async function fetchJsonWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestJson(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function dedupeFilings(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.accession_no) continue;
    const current = map.get(item.accession_no);
    const currentPrimary = current?.raw?.file_type === current?.raw?.form || Number(current?.raw?.sequence) === 1;
    const candidatePrimary = item?.raw?.file_type === item?.raw?.form || Number(item?.raw?.sequence) === 1;
    if (!current || (!currentPrimary && candidatePrimary)) map.set(item.accession_no, item);
  }
  return [...map.values()];
}

async function fetchRecentFilings(filingType, options = {}) {
  const rootForm = normalizeRootForm(filingType);
  const lookbackDays = Math.max(1, Math.min(14, Number(options.lookbackDays || DEFAULT_LOOKBACK_DAYS)));
  const end = options.endDate ? new Date(`${options.endDate}T00:00:00Z`) : new Date();
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid SEC EFTS end date: ${options.endDate}`);
  const fromDate = new Date(end.getTime());
  fromDate.setUTCDate(fromDate.getUTCDate() - lookbackDays);
  const startdt = fromDate.toISOString().slice(0, 10);
  const enddt = end.toISOString().slice(0, 10);
  const results = [];
  let from = 0;

  while (true) {
    const url = buildSearchUrl(rootForm, startdt, enddt, from);
    const data = await fetchJsonWithRetry(url);
    const hits = data?.hits?.hits;
    if (!Array.isArray(hits)) throw new Error('SEC EFTS response missing hits array');

    for (const hit of hits) {
      const source = hit?._source || {};
      const roots = Array.isArray(source.root_forms) ? source.root_forms : [source.root_forms].filter(Boolean);
      const fileDate = source.file_date || '';
      if (roots.length && !roots.includes(rootForm)) continue;
      if (fileDate && (fileDate < startdt || fileDate > enddt)) continue;
      const filing = hitToFiling(hit);
      if (filing.accession_no && filing.cik) results.push(filing);
    }

    from += hits.length;
    const total = Number(data?.hits?.total?.value || 0);
    const relation = String(data?.hits?.total?.relation || 'eq');
    if (!hits.length || (relation === 'eq' && from >= total)) break;
    if (from >= 9900) {
      throw new Error(`SEC EFTS result cap reached for ${rootForm} between ${startdt} and ${enddt}; narrow the lookback window`);
    }
    await sleep(250);
  }

  return dedupeFilings(results);
}

module.exports = {
  ROOT_FORMS,
  cleanAccession,
  normalizeRootForm,
  cleanDisplayName,
  cikFromDisplayName,
  normalizeCik,
  buildEdgarUrl,
  buildSearchUrl,
  hitToFiling,
  dedupeFilings,
  fetchRecentFilings,
};
