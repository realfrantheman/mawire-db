(function () {
  'use strict';

  var root = document.getElementById('sectorDealsList');
  if (!root) return;

  var sector = root.getAttribute('data-sector') || '';
  var source = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/deals.json?t=' + Date.now();

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function matchesSector(deal) {
    var haystack = [deal.sector, deal.headline, deal.summary].join(' ').toLowerCase();
    var aliases = sector === 'Financial Services' ? ['financial', 'bank', 'insurance', 'fintech'] :
      sector === 'Technology' ? ['technology', 'software', 'semiconductor', 'cyber', 'cloud', 'ai'] :
      ['healthcare', 'pharma', 'biotech', 'medical', 'therapeutic'];
    return aliases.some(function (alias) { return haystack.indexOf(alias) !== -1; });
  }

  function permalink(deal) {
    var readable = [deal.acquirer, deal.target].filter(Boolean).join('-').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'deal';
    return '/deal/' + readable + '--' + encodeURIComponent(deal.id);
  }

  fetch(source).then(function (response) {
    if (!response.ok) throw new Error('Deal data returned HTTP ' + response.status);
    return response.json();
  }).then(function (deals) {
    var matches = deals.filter(matchesSector).slice(0, 6);
    if (!matches.length) throw new Error('No matching sector deals are currently available');
    root.innerHTML = matches.map(function (deal) {
      return '<a class="deal-card sector-deal-card" href="' + permalink(deal) + '">' +
        '<div class="deal-card-top"><span class="deal-card-sector">' + esc(deal.sector || sector) + '</span>' +
        '<span class="badge badge-' + esc(String(deal.status || 'announced').toLowerCase()) + '">' + esc(deal.status || 'Announced') + '</span></div>' +
        '<div class="deal-card-headline">' + esc(deal.headline || ((deal.acquirer || 'Unknown acquirer') + ' / ' + (deal.target || 'Unknown target'))) + '</div>' +
        '<div class="deal-card-bottom"><span class="deal-card-value">' + esc(deal.dealValue || 'Undisclosed') + '</span>' +
        '<span class="deal-card-meta">' + esc(deal.date || deal.dateISO || '') + '</span></div></a>';
    }).join('');
  }).catch(function (error) {
    root.innerHTML = '<div class="sector-deals-error">Live deal records are temporarily unavailable. <a href="/?sector=' +
      encodeURIComponent(sector) + '">Open the full deal database</a>.</div>';
    root.setAttribute('data-error', error.message);
  });
})();
