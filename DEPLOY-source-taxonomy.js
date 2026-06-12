'use strict';

window.MergersSourceTaxonomy = {
  categories: [
    { id: 'regulatory', label: 'Regulatory Filings' },
    { id: 'company', label: 'Company Announcements' },
    { id: 'press', label: 'Press Releases' },
    { id: 'exchange', label: 'Exchange Announcements' },
    { id: 'news', label: 'Financial News' }
  ],
  classify: function(deal) {
    var value = String(deal.sourceType || deal.extractionMethod || '') + ' ' +
      String(deal.sourceName || deal.source || '') + ' ' + String(deal.sourceUrl || deal.edgarUrl || '');
    value = value.toLowerCase();
    if (/sec_edgar|sec_filing|eu_merger_registry|regulator|sec\.gov|ec\.europa\.eu/.test(value)) return 'regulatory';
    if (/asx|hkex|sgx|rns|exchange/.test(value)) return 'exchange';
    if (/prnewswire|businesswire|globenewswire|newswire|press_release/.test(value)) return 'press';
    if (/investor|newsroom|company_announcement/.test(value)) return 'company';
    return 'news';
  }
};
