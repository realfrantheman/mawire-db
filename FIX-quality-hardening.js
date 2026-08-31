(function () {
  'use strict';

  var ROOT = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/';
  var INDEX_URL = ROOT + 'deals-index.json';
  var LEGACY_URL = ROOT + 'deals.json';
  var DETAIL_ROOT = ROOT + 'deals-details/';
  var detailCache = Object.create(null);
  var lastModalFocus = null;
  var safeStatus = { announced:'Announced', pending:'Pending', completed:'Completed', terminated:'Terminated', withdrawn:'Withdrawn', rumored:'Rumored', unknown:'Unknown' };

  function cleanUrl(value) {
    if (!value) return '#';
    try {
      var u = new URL(String(value).trim(), window.location.origin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '#';
      return u.href;
    } catch (_) { return '#'; }
  }

  function accessionFromDeal(d) {
    var values = [d && d.accessionNo, d && d.sourceUrl, d && d.edgarUrl];
    for (var i = 0; i < values.length; i++) {
      var m = String(values[i] || '').match(/(\d{10}-\d{2}-\d{6})/);
      if (m) return m[1];
    }
    return null;
  }

  function primarySourceUrl(d) {
    if (!d) return '#';
    var st = String(d.sourceType || d.extractionMethod || '').toLowerCase();
    if (st === 'sec_edgar' || st === 'sec_filing' || st.indexOf('sec') !== -1) {
      var direct = [d.sourceUrl, d.edgarUrl].find(function (v) {
        return /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[^/?#]+/i.test(String(v || '')) && !/-index\.html(?:[?#]|$)/i.test(String(v || ''));
      });
      if (direct) return cleanUrl(direct);
      var acc = accessionFromDeal(d);
      if (acc) {
        var cik = String(parseInt(acc.slice(0, 10), 10));
        return 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + acc.replace(/-/g, '') + '/' + acc + '.txt';
      }
      return '#';
    }
    var u = cleanUrl(d.sourceUrl || d.edgarUrl || '');
    if (/\/(?:rss|rssfeed)(?:\/|\?|$)/i.test(u) || /competition-cases\.ec\.europa\.eu\/search(?:[?#]|$)/i.test(u)) return '#';
    return u;
  }

  function normalizeDeal(d) {
    if (!d || typeof d !== 'object') return d;
    var key = String(d.status || 'unknown').toLowerCase();
    d.status = safeStatus[key] || 'Unknown';
    var source = primarySourceUrl(d);
    d.sourceUrl = source === '#' ? null : source;
    if (String(d.sourceType || d.extractionMethod || '').toLowerCase().indexOf('sec') !== -1) d.edgarUrl = d.sourceUrl;
    return d;
  }

  function isMA(d) {
    if (!d || typeof d.headline !== 'string') return false;
    if (d.dealType === 'Funding Round' || d.dealType === 'Strategic Investment') return false;
    return !/\bearnings?\b|\bquarterly results?\b|\bannual results?\b|\bproduct launch\b|\bIPO priced\b|\bjoint venture\b|\bpartnership agreement\b|\blicen(?:se|sing) agreement\b/i.test(d.headline);
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'default' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  safeUrl = cleanUrl;

  loadDeals = function () {
    showLoading();
    fetchJson(INDEX_URL).catch(function () { return fetchJson(LEGACY_URL); }).then(function (data) {
      if (!Array.isArray(data) || !data.length) throw new Error('Empty deal index');
      allDeals = data.filter(isMA).map(normalizeDeal);
      window.allDeals = allDeals;
      onDealsLoaded();
    }).catch(function (err) {
      console.error('[mergers.news] Load error:', err);
      showError();
    });
  };

  function detailKey(d) {
    var y = String((d && d.year) || String((d && d.dateISO) || '').slice(0, 4));
    return /^\d{4}$/.test(y) ? y : 'unknown';
  }

  function loadDetail(d) {
    if (!d || !d.id) return Promise.resolve(d);
    if (d.body || d.summary) return Promise.resolve(d);
    var key = detailKey(d);
    if (!detailCache[key]) detailCache[key] = fetchJson(DETAIL_ROOT + encodeURIComponent(key) + '.json').catch(function () { return []; });
    return detailCache[key].then(function (rows) {
      var full = rows.find(function (x) { return x.id === d.id; });
      return full ? normalizeDeal(full) : d;
    });
  }

  var originalPopulateModal = populateModal;
  populateModal = function (deal) {
    deal = normalizeDeal(deal);
    originalPopulateModal(deal);
    var titleCandidates = document.querySelectorAll('.modal-section-title,.modal-section-label,h3');
    titleCandidates.forEach(function (node) { if (node.textContent.trim() === 'SEC Documents') node.textContent = 'Source Documents'; });
    var actions = document.getElementById('modalActions');
    if (actions) {
      actions.querySelectorAll('[onclick]').forEach(function (node) { node.removeAttribute('onclick'); });
      var buttons = actions.querySelectorAll('button');
      buttons.forEach(function (button) {
        if (/share/i.test(button.textContent)) button.addEventListener('click', shareModal, { once: true });
        if (/export/i.test(button.textContent)) button.addEventListener('click', exportModalCSV, { once: true });
      });
    }
    var comps = findComparables(deal);
    var items = document.querySelectorAll('#modalComparableItems .comparable-item');
    items.forEach(function (item, i) {
      item.removeAttribute('onclick');
      item.setAttribute('tabindex', '0');
      var comp = comps[i];
      if (!comp) return;
      var open = function () { openModal(comp); };
      item.addEventListener('click', open);
      item.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  };

  var originalOpenModal = openModal;
  openModal = function (deal) {
    lastModalFocus = document.activeElement;
    originalOpenModal(normalizeDeal(deal));
    loadDetail(deal).then(function (full) {
      if (currentDeal && full && currentDeal.id === full.id) {
        currentDeal = full;
        populateModal(full);
      }
    });
  };
  window.openModal = openModal;

  var originalCloseModal = closeModal;
  closeModal = function () {
    originalCloseModal();
    if (lastModalFocus && typeof lastModalFocus.focus === 'function') setTimeout(function () { lastModalFocus.focus(); }, 0);
  };

  var originalHeroFeed = renderHeroFeed;
  renderHeroFeed = function () {
    originalHeroFeed();
    var rows = allDeals.slice(0, 6);
    document.querySelectorAll('#heroFeed .hero-feed-item').forEach(function (item, i) {
      item.removeAttribute('onclick');
      item.setAttribute('tabindex', '0');
      var deal = rows[i];
      if (!deal) return;
      var open = function () { openModal(deal); };
      item.addEventListener('click', open);
      item.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  };

  var originalLoadMoreMobile = loadMoreMobile;
  loadMoreMobile = function () {
    originalLoadMoreMobile();
    document.querySelectorAll('#dealCardsList .deal-card').forEach(function (card) {
      if (card.dataset.keyboardReady === '1') return;
      card.dataset.keyboardReady = '1';
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
    });
  };

  function csvCell(value) {
    var s = String(value == null ? '' : value);
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  exportCSV = function () {
    if (!filteredDeals.length) return;
    var rows = filteredDeals.map(function (d) {
      return [d.headline,d.acquirer,d.target,d.dealValue,d.date || d.year,d.dealType,d.sector,d.status,d.filingType,primarySourceUrl(d)].map(csvCell).join(',');
    });
    downloadText('Headline,Acquirer,Target,Deal Value,Date,Type,Sector,Status,Filing Type,Source URL\n' + rows.join('\n'), 'mergers-news-deals.csv', 'text/csv');
  };

  exportModalCSV = function () {
    if (!currentDeal) return;
    var d = currentDeal;
    var csv = 'Headline,Acquirer,Target,Deal Value,Date,Type,Sector,Status,Source URL\n' +
      [d.headline,d.acquirer,d.target,d.dealValue,d.date || d.year,d.dealType,d.sector,d.status,primarySourceUrl(d)].map(csvCell).join(',');
    downloadText(csv, 'deal.csv', 'text/csv');
  };
  window.exportModalCSV = exportModalCSV;

  var originalOnDealsLoaded = onDealsLoaded;
  onDealsLoaded = function () {
    originalOnDealsLoaded();
    var ticker = document.getElementById('tickerContent');
    var label = document.querySelector('.ticker-label');
    if (label) label.textContent = 'DATA';
    if (ticker) {
      var currentYear = String(new Date().getUTCFullYear());
      var ytd = allDeals.filter(function (d) { return String(d.year || d.dateISO || '').slice(0, 4) === currentYear; }).length;
      var sourced = allDeals.filter(function (d) { return primarySourceUrl(d) !== '#'; }).length;
      var items = [
        allDeals.length.toLocaleString() + ' M&A transactions indexed',
        ytd.toLocaleString() + ' transactions dated ' + currentYear,
        sourced.toLocaleString() + ' records link directly to a public source',
        'Regulatory filings · company announcements · press releases · exchange notices'
      ];
      ticker.innerHTML = items.concat(items).map(function (x) { return '<span class="tick-item"><span class="tick-dot">▶</span> ' + esc(x) + '</span>'; }).join('');
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    var overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.setAttribute('tabindex', '-1');
    document.getElementById('filterDropdown') && document.getElementById('filterDropdown').addEventListener('click', function (e) {
      var pill = e.target.closest('.filter-pill[data-filter^="type-"]');
      if (!pill) return;
      state.type = pill.dataset.filter.slice(5);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !overlay || !overlay.classList.contains('open')) return;
      var focusable = Array.from(overlay.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(function (node) { return node.offsetParent !== null; });
      if (!focusable.length) { e.preventDefault(); overlay.focus(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });
})();
