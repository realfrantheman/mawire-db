'use strict';
const fs = require('fs');
const { isLandingPage, isDirectSecArchiveFile } = require('./FIX-source-url');

function validate(deals) {
  const errors = [];
  let missing = 0;
  for (const d of deals) {
    const url = d.sourceUrl;
    if (!url) { missing++; continue; }
    if (!/^https?:\/\//i.test(url)) errors.push(`${d.id}: non-http source URL`);
    if (isLandingPage(url)) errors.push(`${d.id}: landing/search/feed URL is not a direct source: ${url}`);
    const st = String(d.sourceType || d.extractionMethod || '').toLowerCase();
    if ((st === 'sec_edgar' || st === 'sec_filing' || st.includes('sec')) && !isDirectSecArchiveFile(url)) {
      errors.push(`${d.id}: SEC source is not a direct archive document: ${url}`);
    }
  }
  return { errors, missing };
}

if (require.main === module) {
  const deals = JSON.parse(fs.readFileSync(process.argv[2] || 'deals-index.json', 'utf8'));
  const result = validate(deals);
  console.log(`[SOURCE-URL] ${deals.length} deals · ${result.missing} without a recoverable source · ${result.errors.length} invalid links`);
  if (result.errors.length) {
    console.error(result.errors.slice(0, 30).join('\n'));
    process.exit(1);
  }
}
module.exports = { validate };
