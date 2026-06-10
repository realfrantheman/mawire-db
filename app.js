/* ═══════════════════════════════════════════════════════════════
   mergers.news — Next Generation App
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── CONFIG ──────────────────────────────────────────────────── */
var GITHUB_DB  = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/deals.json';
var PAGE_SIZE  = 50;

/* ── STATE ───────────────────────────────────────────────────── */
var allDeals      = [];
var filteredDeals = [];
var currentPage   = 0;
var currentDeal   = null;
var searchTimer   = null;

var state = {
  search:   '',
  status:   'all',
  sector:   'all',
  value:    'all',
  type:     'all',
  sort:     'newest',
  dateFrom: '',
  dateTo:   ''
};

/* ── SANITISATION ────────────────────────────────────────────── */
function esc(s) {
  if (s == null) return '';
  var str = String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/`/g,  '&#96;');
  if (/^(javascript|data|vbscript):/i.test(str.trim())) return '#';
  return str;
}
function safeUrl(s) {
  if (!s) return '#';
  var str = String(s).trim();
  if (/^https?:\/\//i.test(str) || /^\//.test(str)) return str;
  return '#';
}

/* ── CLOCK ───────────────────────────────────────────────────── */
function startClock() {
  var el = document.getElementById('liveClock');
  if (!el) return;
  function tick() { el.textContent = new Date().toUTCString().split(' ')[4] + ' UTC'; }
  tick(); setInterval(tick, 1000);
}

/* ── HEADER PADDING ──────────────────────────────────────────── */
function updatePadding() {
  var h = document.getElementById('siteHeader');
  var m = document.getElementById('mainContent');
  if (h && m) m.style.paddingTop = (h.offsetHeight + 28 + 12) + 'px';
}

/* ── COMMAND PALETTE ─────────────────────────────────────────── */
var cmdOpen = false;
var cmdSelected = -1;

function openCmd() {
  var overlay = document.getElementById('cmdOverlay');
  var input   = document.getElementById('cmdInput');
  if (!overlay || !input) return;
  overlay.classList.add('open');
  cmdOpen = true;
  cmdSelected = -1;
  setTimeout(function() { input.focus(); }, 50);
}

function closeCmd() {
  var overlay = document.getElementById('cmdOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  cmdOpen = false;
  cmdSelected = -1;
  document.getElementById('cmdInput').value = '';
  document.getElementById('cmdResults').style.display = 'none';
  document.getElementById('cmdBody').style.display = '';
}

function setupCmd() {
  var trigger = document.getElementById('searchTrigger');
  var overlay = document.getElementById('cmdOverlay');
  var closeBtn = document.getElementById('cmdClose');
  var input    = document.getElementById('cmdInput');
  var results  = document.getElementById('cmdResults');
  var body     = document.getElementById('cmdBody');

  if (!trigger) return;

  trigger.addEventListener('click', openCmd);
  if (closeBtn) closeBtn.addEventListener('click', closeCmd);

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeCmd();
  });

  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      cmdOpen ? closeCmd() : openCmd();
    }
    if (e.key === 'Escape' && cmdOpen) closeCmd();
  });

  // Mobile search
  var mobileBtn = document.getElementById('mobileSearchBtn');
  if (mobileBtn) mobileBtn.addEventListener('click', openCmd);

  // CMD items navigation
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var selected = document.querySelector('.cmd-item.selected');
      if (selected) {
        handleCmdItem(selected);
        return;
      }
      // Otherwise do search
      if (input.value.trim()) {
        performCmdSearch(input.value.trim());
      }
    }
  });

  // CMD live search
  var cmdTimer = null;
  input.addEventListener('input', function() {
    var q = input.value.trim();
    clearTimeout(cmdTimer);
    if (!q) {
      results.style.display = 'none';
      body.style.display = '';
      saveRecentSearch(''); // don't save empty
      return;
    }
    body.style.display = 'none';
    results.style.display = '';
    cmdTimer = setTimeout(function() { renderCmdResults(q); }, 150);
  });

  // Navigate cmd items
  document.addEventListener('keydown', function(e) {
    if (!cmdOpen) return;
    var items = document.querySelectorAll('.cmd-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelected = Math.min(cmdSelected + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelected = Math.max(cmdSelected - 1, -1);
    }
    items.forEach(function(item, i) {
      item.classList.toggle('selected', i === cmdSelected);
    });
  });

  // Click cmd items
  document.getElementById('cmdPalette').addEventListener('click', function(e) {
    var item = e.target.closest('.cmd-item');
    if (item) handleCmdItem(item);
  });

  renderRecentSearches();
  loadRecentSearches();
}

function handleCmdItem(item) {
  var action = item.dataset.action;
  if (action === 'goto') {
    window.location.href = item.dataset.href;
  } else if (action === 'deal') {
    var id = item.dataset.id;
    var deal = allDeals.find(function(d) { return d.id === id; });
    if (deal) { openModal(deal); closeCmd(); }
  } else if (action === 'search') {
    var q = item.dataset.q;
    closeCmd();
    document.getElementById('searchInput').value = q;
    state.search = q.toLowerCase();
    applyFilters();
    document.getElementById('dealDatabaseSection').scrollIntoView({ behavior: 'smooth' });
  }
}

function renderCmdResults(q) {
  var results = document.getElementById('cmdResults');
  if (!allDeals.length) {
    results.innerHTML = '<div class="cmd-section"><div class="cmd-section-label">Loading…</div></div>';
    return;
  }
  var ql = q.toLowerCase();
  var matches = allDeals.filter(function(d) {
    return (d.headline && d.headline.toLowerCase().includes(ql)) ||
           (d.acquirer && d.acquirer.toLowerCase().includes(ql)) ||
           (d.target   && d.target.toLowerCase().includes(ql)) ||
           (d.sector   && d.sector.toLowerCase().includes(ql));
  }).slice(0, 8);

  var html = '';
  if (matches.length) {
    html += '<div class="cmd-section"><div class="cmd-section-label">Deals</div>';
    matches.forEach(function(d) {
      html += '<div class="cmd-item" data-action="deal" data-id="' + esc(d.id) + '">' +
        '<span class="cmd-item-icon">📊</span>' +
        '<div class="cmd-item-text">' +
          '<div class="cmd-item-title">' + esc(d.headline || d.acquirer + ' / ' + d.target) + '</div>' +
          '<div class="cmd-item-sub">' + esc(d.sector || '') + ' · ' + esc(d.date || String(d.year || '')) + '</div>' +
        '</div>' +
        '<span class="cmd-item-value">' + esc(d.dealValue || '') + '</span>' +
        '</div>';
    });
    html += '</div>';
  }

  // Search all option
  html += '<div class="cmd-section">' +
    '<div class="cmd-item" data-action="search" data-q="' + esc(q) + '">' +
      '<span class="cmd-item-icon">⌕</span>' +
      '<div class="cmd-item-text"><div class="cmd-item-title">Search all deals for "' + esc(q) + '"</div></div>' +
    '</div></div>';

  results.innerHTML = html;
}

// Recent searches
var RECENT_KEY = 'mn_recent_searches';
function loadRecentSearches() { return JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]'); }
function saveRecentSearch(q) {
  if (!q) return;
  var recents = loadRecentSearches().filter(function(r) { return r !== q; });
  recents.unshift(q);
  recents = recents.slice(0, 5);
  sessionStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}
function renderRecentSearches() {
  var recents = loadRecentSearches();
  var container = document.getElementById('cmdRecentItems');
  var section   = document.getElementById('cmdRecent');
  if (!container) return;
  if (!recents.length) { if (section) section.style.display = 'none'; return; }
  if (section) section.style.display = '';
  container.innerHTML = recents.map(function(r) {
    return '<div class="cmd-item" data-action="search" data-q="' + esc(r) + '">' +
      '<span class="cmd-item-icon" style="font-size:12px">⏱</span>' +
      '<div class="cmd-item-text"><div class="cmd-item-title">' + esc(r) + '</div></div>' +
      '</div>';
  }).join('');
}

function performCmdSearch(q) {
  saveRecentSearch(q);
  closeCmd();
  document.getElementById('searchInput').value = q;
  state.search = q.toLowerCase();
  applyFilters();
  document.getElementById('dealDatabaseSection').scrollIntoView({ behavior: 'smooth' });
}

/* ── HERO SEARCH ─────────────────────────────────────────────── */
function setupHeroSearch() {
  var input = document.getElementById('heroSearchInput');
  var btn   = document.getElementById('heroSearchBtn');
  var chips = document.querySelectorAll('.hero-chip');

  function doSearch() {
    var q = input.value.trim();
    if (!q) return;
    saveRecentSearch(q);
    state.search = q.toLowerCase();
    document.getElementById('searchInput').value = q;
    applyFilters();
    document.getElementById('dealDatabaseSection').scrollIntoView({ behavior: 'smooth' });
  }

  if (btn) btn.addEventListener('click', doSearch);
  if (input) input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearch(); });

  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      var q = chip.dataset.q;
      input.value = q;
      doSearch();
    });
  });
}

/* ── DYNAMIC COUNT HELPER ────────────────────────────────────────── */
function getRoundedDealCount(n) {
  if (!n || n < 100) return n || 0;
  return Math.floor(n / 100) * 100;
}

/* ── DATA LOADING ────────────────────────────────────────────── */
function loadDeals() {
  showLoading();
  var url = GITHUB_DB + '?t=' + Date.now();
  fetch(url)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!Array.isArray(data) || !data.length) throw new Error('Empty');

      // Validate and sanitise
      // Funding Round and Strategic Investment are not M&A transactions.
      // Divestiture IS a valid M&A transaction — intentionally excluded from this list.
      var NON_MA_TYPES = { 'Funding Round': 1, 'Strategic Investment': 1 };
      // Headlines clearly indicating non-M&A content
      var NON_MA_HEADLINE = /\bto (?:release|launch|unveil|introduce|present|ship|report)\b|\bearnings?\b|\bquarterly results?\b|\bannual results?\b|\bproduct launch\b|\bsensor\b|\bfirmware\b|\bsoftware update\b|\bIPO priced\b|\bappoints?\s+(?:new\s+)?(?:ceo|cfo|coo|cto|president|chairman|vp)\b|\bnames?\s+(?:new\s+)?(?:ceo|cfo|coo|cto|president|chairman)\b|\braises?\s+\$\d|\bseries [a-e]\s+(?:funding|round|investment)\b|\bjoint venture\b|\bpartnership agreement\b|\bdistribution agreement\b|\blicen(?:se|sing) agreement\b/i;
      var safe = data.filter(function(d) {
        if (!d || typeof d !== 'object') return false;
        if (typeof d.headline !== 'string') return false;
        if (d.dealType && NON_MA_TYPES[d.dealType]) return false;
        if (NON_MA_HEADLINE.test(d.headline)) return false;
        var fields = [d.headline, d.acquirer, d.target, d.body];
        for (var i = 0; i < fields.length; i++) {
          if (typeof fields[i] === 'string' && /<script/i.test(fields[i])) return false;
        }
        return true;
      });

      allDeals = safe;
      onDealsLoaded();
    })
    .catch(function(err) {
      console.error('[mergers.news] Load error:', err);
      showError();
    });
}

function onDealsLoaded() {
  updateHeroStats();
  updateKPIs();
  renderHeroFeed();
  applyFilters();
  updateIndustryCounts();
  if (window.renderVolumeChart) window.renderVolumeChart(allDeals);

  // Open deal from permalink /deal/12345
  if (window._pendingDealId) {
    var deal = allDeals.find(function(d) { return d.id === window._pendingDealId; });
    window._pendingDealId = null;
    if (deal) setTimeout(function() { openModal(deal); }, 50);
  }
}

function showLoading() {
  el('loadingState') && show('loadingState');
  el('dealTable')    && hide('dealTable');
  el('errorState')   && hide('errorState');
  el('noResultsState') && hide('noResultsState');
  el('loadMoreWrap') && hide('loadMoreWrap');
}
function showError() {
  el('loadingState') && hide('loadingState');
  el('errorState')   && show('errorState');
}
function el(id) { return document.getElementById(id); }
function show(id) { var e = el(id); if (e) e.style.display = ''; }
function hide(id) { var e = el(id); if (e) e.style.display = 'none'; }

/* ── STATS UPDATE ────────────────────────────────────────────── */
function updateHeroStats() {
  var total   = allDeals.length;
  var rounded = getRoundedDealCount(total);
  var display = rounded ? rounded.toLocaleString() + '+' : '10,000+';

  var heroStat = el('heroStatDeals');
  if (heroStat) heroStat.textContent = display;

  // Update hero subtitle and any other dynamic count spans
  var subtitleCount = el('heroSubtitleCount');
  if (subtitleCount) subtitleCount.textContent = display;
}

function updateKPIs() {
  // 2026 deal count
  var ytd = allDeals.filter(function(d) {
    return String(d.year || d.dateISO || '').slice(0, 4) === '2026';
  }).length;
  var kpiYtd = el('kpiYtd');
  if (kpiYtd) kpiYtd.textContent = ytd ? ytd.toLocaleString() : '—';

  // Most active sector
  var sectorCount = {};
  allDeals.forEach(function(d) {
    if (d.sector) sectorCount[d.sector] = (sectorCount[d.sector] || 0) + 1;
  });
  var topSector = Object.keys(sectorCount).sort(function(a,b) { return sectorCount[b]-sectorCount[a]; })[0];
  if (topSector) {
    var kpiSector = el('kpiSector');
    var kpiSectorSub = el('kpiSectorSub');
    if (kpiSector) kpiSector.textContent = topSector;
    if (kpiSectorSub) kpiSectorSub.textContent = sectorCount[topSector].toLocaleString() + ' deals';
  }
}

function updateIndustryCounts() {
  var counts = {};
  allDeals.forEach(function(d) {
    if (d.sector) counts[d.sector] = (counts[d.sector] || 0) + 1;
  });
  var map = {
    'Technology': 'indTech', 'Healthcare': 'indHealth',
    'Financial Services': 'indFinance', 'Finance': 'indFinance',
    'Energy': 'indEnergy', 'Consumer': 'indConsumer',
    'Telecommunications': 'indTelecom', 'Telecom': 'indTelecom',
    'Media': 'indMedia'
  };
  Object.keys(map).forEach(function(sector) {
    var e = el(map[sector]);
    if (e && counts[sector]) {
      var c = counts[sector];
      e.textContent = getRoundedDealCount(c).toLocaleString() + (c > 99 ? '+' : '');
    }
  });
}

function renderHeroFeed() {
  var feed = el('heroFeed');
  if (!feed || !allDeals.length) return;
  var recent = allDeals.slice(0, 6);
  feed.innerHTML = recent.map(function(d) {
    return '<div class="hero-feed-item" onclick="openModal(allDeals[' + allDeals.indexOf(d) + '])">' +
      '<div class="hero-feed-sector">' + esc(d.sector || d.dealType || 'Transaction') + '</div>' +
      '<div class="hero-feed-headline">' + esc(d.headline || (d.acquirer + ' / ' + d.target)) + '</div>' +
      '<div class="hero-feed-meta">' +
        '<span class="hero-feed-value">' + esc(d.dealValue || 'Undisclosed') + '</span>' +
        '<span>·</span>' +
        '<span>' + esc(d.date || String(d.year || '')) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ── FILTERS ─────────────────────────────────────────────────── */
function setupFilters() {
  var searchInput = el('searchInput');
  var searchClear = el('searchClear');
  var retryBtn    = el('retryBtn');
  var clearSearch = el('clearSearchBtn');
  var exportBtn   = el('exportBtn');

  if (searchInput) {
    searchInput.addEventListener('input', function() {
      state.search = searchInput.value.trim().toLowerCase();
      if (searchClear) searchClear.style.display = state.search ? '' : 'none';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 300);
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { clearTimeout(searchTimer); applyFilters(); }
    });
  }

  if (searchClear) searchClear.addEventListener('click', function() {
    searchInput.value = ''; state.search = '';
    searchClear.style.display = 'none';
    applyFilters();
  });

  if (retryBtn)    retryBtn.addEventListener('click', loadDeals);
  if (clearSearch) clearSearch.addEventListener('click', clearAllFilters);
  if (exportBtn)   exportBtn.addEventListener('click', exportCSV);

  // Filter pills toggle dropdown
  var pills = document.querySelectorAll('.deal-table-controls .filter-pill');
  pills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var dropdown = el('filterDropdown');
      if (dropdown) dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });
  });

  // Dropdown filter pills
  var dropFilters = document.querySelectorAll('#filterDropdown .filter-pill');
  dropFilters.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var filter = pill.dataset.filter;
      if (!filter) return;
      var parts = filter.split('-');
      var type  = parts[0];
      var val   = parts.slice(1).join('-');

      // Deactivate siblings
      var siblings = pill.parentElement.querySelectorAll('.filter-pill');
      siblings.forEach(function(s) { s.classList.remove('active'); });
      pill.classList.add('active');

      if (type === 'status') state.status = val;
      else if (type === 'sector') state.sector = val;
      else if (type === 'value')  state.value  = val;
      else if (type === 'sort')   state.sort   = val;
    });
  });

  if (el('applyFiltersBtn')) {
    el('applyFiltersBtn').addEventListener('click', function() {
      el('filterDropdown').style.display = 'none';
      applyFilters();
    });
  }
  if (el('clearFiltersBtn')) {
    el('clearFiltersBtn').addEventListener('click', function() {
      clearAllFilters();
      el('filterDropdown').style.display = 'none';
    });
  }
}

function clearAllFilters() {
  state = { search: '', status: 'all', sector: 'all', value: 'all', type: 'all', sort: 'newest', dateFrom: '', dateTo: '' };
  if (el('searchInput')) el('searchInput').value = '';
  if (el('searchClear')) el('searchClear').style.display = 'none';
  document.querySelectorAll('#filterDropdown .filter-pill').forEach(function(p) {
    var filter = p.dataset.filter || '';
    p.classList.toggle('active', filter.endsWith('-all') || filter === 'sort-newest');
  });
  applyFilters();
}

function filterBySector(sector) {
  state.sector = sector;
  applyFilters();
  document.getElementById('dealDatabaseSection').scrollIntoView({ behavior: 'smooth' });
}

function filterByType(type) {
  state.type = type;
  applyFilters();
  document.getElementById('dealDatabaseSection').scrollIntoView({ behavior: 'smooth' });
}

/* ── APPLY FILTERS ───────────────────────────────────────────── */
function applyFilters() {
  var results = allDeals.filter(function(d) {
    // Search
    if (state.search) {
      var ql = state.search;
      var match = (d.headline  && d.headline.toLowerCase().includes(ql)) ||
                  (d.acquirer  && d.acquirer.toLowerCase().includes(ql))  ||
                  (d.target    && d.target.toLowerCase().includes(ql))    ||
                  (d.sector    && d.sector.toLowerCase().includes(ql))    ||
                  (d.dealType  && d.dealType.toLowerCase().includes(ql))  ||
                  (d.body      && d.body.toLowerCase().includes(ql));
      if (!match) return false;
    }
    // Status
    if (state.status !== 'all' && d.status !== state.status) return false;
    // Sector
    if (state.sector !== 'all') {
      var dSector = (d.sector || '').toLowerCase();
      var fSector = state.sector.toLowerCase();
      if (!dSector.includes(fSector)) return false;
    }
    // Type
    if (state.type !== 'all' && d.dealType !== state.type) return false;
    // Value
    if (state.value !== 'all') {
      var v = parseFloat((d.dealValue || '').replace(/[^0-9.]/g,''));
      var unit = (d.dealValue || '').toUpperCase();
      if (unit.includes('B')) v *= 1e9;
      else if (unit.includes('M')) v *= 1e6;
      if (state.value === 'mega'  && !(v >= 10e9)) return false;
      if (state.value === 'large' && !(v >= 1e9 && v < 10e9)) return false;
      if (state.value === 'mid'   && !(v >= 100e6 && v < 1e9)) return false;
      if (state.value === 'small' && !(v > 0 && v < 100e6)) return false;
    }
    return true;
  });

  // Sort — prefer dateISO for precise ordering; fall back to year
  results.sort(function(a, b) {
    if (state.sort === 'newest') {
      var ad = a.dateISO || String(a.year || ''), bd = b.dateISO || String(b.year || '');
      return bd.localeCompare(ad);
    }
    if (state.sort === 'oldest') {
      var ad = a.dateISO || String(a.year || ''), bd = b.dateISO || String(b.year || '');
      return ad.localeCompare(bd);
    }
    if (state.sort === 'largest') {
      return parseDealValue(b.dealValue) - parseDealValue(a.dealValue);
    }
    if (state.sort === 'smallest') {
      var av = parseDealValue(a.dealValue), bv = parseDealValue(b.dealValue);
      if (!av && !bv) return 0;
      if (!av) return 1; if (!bv) return -1;
      return av - bv;
    }
    return 0;
  });

  filteredDeals = results;
  currentPage   = 0;

  updateDealCount(results.length);
  renderDeals();
}

function parseDealValue(v) {
  if (!v) return 0;
  var n = parseFloat(String(v).replace(/[^0-9.]/g,''));
  var u = String(v).toUpperCase();
  if (u.includes('B')) return n * 1e9;
  if (u.includes('M')) return n * 1e6;
  return n;
}

function updateDealCount(count) {
  var txt    = el('dealCountText');
  var badge  = el('dealCountBadge');
  var label  = count.toLocaleString() + ' deal' + (count !== 1 ? 's' : '');
  if (txt)   txt.textContent   = label;
  if (badge) badge.textContent = label;
}

/* ── RENDER DEALS ────────────────────────────────────────────── */
function renderDeals() {
  hide('loadingState');
  hide('errorState');

  if (!filteredDeals.length) {
    hide('dealTable');
    show('noResultsState');
    hide('loadMoreWrap');
    return;
  }
  hide('noResultsState');

  var isMobile  = window.innerWidth < 768;
  var isFiltered = state.search || state.status !== 'all' || state.sector !== 'all' ||
                   state.value  !== 'all' || state.type  !== 'all';

  if (isMobile) {
    hide('dealTableWrap');
    renderMobileCards(isFiltered);
  } else {
    hide('dealCardsWrap');
    renderDesktopTable(isFiltered);
  }
}

function renderDesktopTable(isFiltered) {
  show('dealTableWrap');
  var table = el('dealTable');
  var tbody = el('dealList');
  if (!table || !tbody) return;
  table.style.display = '';

  var toRender = isFiltered ? filteredDeals : filteredDeals.slice(0, PAGE_SIZE);
  tbody.innerHTML = toRender.map(function(d, i) {
    return buildRow(d, i);
  }).join('');

  // Load more
  var lmw = el('loadMoreWrap');
  var lmb = el('loadMoreBtn');
  var lmc = el('loadMoreCount');
  if (!isFiltered && filteredDeals.length > PAGE_SIZE) {
    currentPage = 1;
    if (lmw) lmw.style.display = '';
    if (lmb) {
      lmb.onclick = loadMoreDeals;
      lmb.querySelector('span').textContent = 'Load 50 More Deals';
    }
    if (lmc) lmc.textContent = 'Showing ' + PAGE_SIZE.toLocaleString() + ' of ' + filteredDeals.length.toLocaleString() + ' deals';
  } else {
    if (lmw) lmw.style.display = 'none';
  }

  // Row click handlers
  tbody.querySelectorAll('tr').forEach(function(row, i) {
    var deal = toRender[i];
    if (!deal) return;
    row.addEventListener('click', function() { openModal(deal); });
    row.addEventListener('keydown', function(e) { if (e.key === 'Enter') openModal(deal); });
  });
}

function loadMoreDeals() {
  var start = currentPage * PAGE_SIZE;
  var end   = Math.min(start + PAGE_SIZE, filteredDeals.length);
  var tbody = el('dealList');
  if (!tbody) return;

  var frag = document.createDocumentFragment();
  for (var i = start; i < end; i++) {
    var tr = document.createElement('tr');
    tr.setAttribute('tabindex', '0');
    tr.innerHTML = buildRowInner(filteredDeals[i]);
    (function(deal) {
      tr.addEventListener('click', function() { openModal(deal); });
      tr.addEventListener('keydown', function(e) { if (e.key === 'Enter') openModal(deal); });
    })(filteredDeals[i]);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  currentPage++;

  var shown = Math.min(currentPage * PAGE_SIZE, filteredDeals.length);
  var remaining = filteredDeals.length - shown;
  var lmw = el('loadMoreWrap');
  var lmc = el('loadMoreCount');
  if (remaining <= 0) {
    if (lmw) lmw.style.display = 'none';
  } else {
    if (lmc) lmc.textContent = 'Showing ' + shown.toLocaleString() + ' of ' + filteredDeals.length.toLocaleString() + ' deals';
  }
}

function buildRow(d, i) {
  return '<tr tabindex="0">' + buildRowInner(d) + '</tr>';
}

function buildRowInner(d) {
  var statusClass = 'badge-' + (d.status || 'rumored').toLowerCase();
  var displaySector = (d.sector && d.sector !== 'Other') ? d.sector : inferSector(d);
  var filingType  = getFilingLabel(d);
  var filingUrl   = safeUrl(d.sourceUrl || d.edgarUrl || '#');

  return '<td class="deal-date-cell">' + esc(d.date || String(d.year || '—')) + '</td>' +
    '<td class="deal-headline-cell">' +
      '<div class="headline">' + esc(d.headline || (d.acquirer + ' / ' + d.target)) + '</div>' +
      '<div class="parties">' + esc(d.acquirer || '—') + ' → ' + esc(d.target || '—') + '</div>' +
    '</td>' +
    '<td class="deal-value-cell' + (!d.dealValue || d.dealValue === 'Undisclosed' ? ' undisclosed' : '') + '">' +
      esc(d.dealValue || '—') +
    '</td>' +
    '<td class="deal-type-cell">' + esc(d.dealType || '—') + '</td>' +
    '<td class="deal-sector-cell">' + esc(displaySector || '—') + '</td>' +
    '<td><span class="badge ' + statusClass + '">' + esc(d.status || 'Unknown') + '</span></td>' +
    '<td>' +
      (filingUrl && filingUrl !== '#'
        ? '<a href="' + filingUrl + '" target="_blank" rel="noopener" class="deal-filing-link" onclick="event.stopPropagation()">' + esc(filingType) + ' ↗</a>'
        : '<span style="font-family:var(--mono);font-size:10px;color:var(--muted2)">' + esc(filingType) + '</span>') +
    '</td>';
}

function renderMobileCards(isFiltered) {
  show('dealCardsWrap');
  var container = el('dealCardsList');
  if (!container) return;

  var toRender = isFiltered ? filteredDeals : filteredDeals.slice(0, PAGE_SIZE);

  container.innerHTML = toRender.map(function(d) {
    var statusClass = 'badge-' + (d.status || 'rumored').toLowerCase();
    return '<div class="deal-card" tabindex="0" data-id="' + esc(d.id) + '">' +
      '<div class="deal-card-top">' +
        '<span class="deal-card-sector">' + esc(d.sector || d.dealType || 'M&A') + '</span>' +
        '<span class="badge ' + statusClass + '">' + esc(d.status || '') + '</span>' +
      '</div>' +
      '<div class="deal-card-headline">' + esc(d.headline || (d.acquirer + ' / ' + d.target)) + '</div>' +
      (d.summary ? '<div class="deal-card-summary">' + esc(d.summary) + '</div>' : '') +
      '<div class="deal-card-bottom">' +
        '<span class="deal-card-value">' + esc(d.dealValue || 'Undisclosed') + '</span>' +
        '<span class="deal-card-meta">' + esc(d.date || String(d.year || '')) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  // Card click handlers
  container.querySelectorAll('.deal-card').forEach(function(card, i) {
    var deal = toRender[i];
    if (!deal) return;
    card.addEventListener('click', function() { openModal(deal); });
    card.addEventListener('keydown', function(e) { if (e.key === 'Enter') openModal(deal); });
  });

  // Mobile load more
  var lmwm = el('loadMoreWrapMobile');
  var lmbm = el('loadMoreBtnMobile');
  var lmcm = el('loadMoreCountMobile');
  if (!isFiltered && filteredDeals.length > PAGE_SIZE) {
    currentPage = 1;
    if (lmwm) lmwm.style.display = '';
    if (lmbm) lmbm.onclick = loadMoreMobile;
    if (lmcm) lmcm.textContent = 'Showing ' + PAGE_SIZE.toLocaleString() + ' of ' + filteredDeals.length.toLocaleString() + ' deals';
  } else {
    if (lmwm) lmwm.style.display = 'none';
  }
}

function loadMoreMobile() {
  var start = currentPage * PAGE_SIZE;
  var end   = Math.min(start + PAGE_SIZE, filteredDeals.length);
  var container = el('dealCardsList');
  if (!container) return;

  var html = '';
  for (var i = start; i < end; i++) {
    var d = filteredDeals[i];
    var sc = 'badge-' + (d.status || 'rumored').toLowerCase();
    html += '<div class="deal-card" tabindex="0" data-idx="' + i + '">' +
      '<div class="deal-card-top"><span class="deal-card-sector">' + esc(d.sector || d.dealType || 'M&A') + '</span><span class="badge ' + sc + '">' + esc(d.status || '') + '</span></div>' +
      '<div class="deal-card-headline">' + esc(d.headline || (d.acquirer + ' / ' + d.target)) + '</div>' +
      (d.summary ? '<div class="deal-card-summary">' + esc(d.summary) + '</div>' : '') +
      '<div class="deal-card-bottom"><span class="deal-card-value">' + esc(d.dealValue || 'Undisclosed') + '</span><span class="deal-card-meta">' + esc(d.date || String(d.year || '')) + '</span></div>' +
    '</div>';
  }

  var temp = document.createElement('div');
  temp.innerHTML = html;
  Array.from(temp.children).forEach(function(card, j) {
    var deal = filteredDeals[start + j];
    if (deal) {
      card.addEventListener('click', function() { openModal(deal); });
    }
    container.appendChild(card);
  });

  currentPage++;
  var shownM = Math.min(currentPage * PAGE_SIZE, filteredDeals.length);
  var remainingM = filteredDeals.length - shownM;
  var lmwm = el('loadMoreWrapMobile');
  var lmcm = el('loadMoreCountMobile');
  if (remainingM <= 0) { if (lmwm) lmwm.style.display = 'none'; }
  else if (lmcm) lmcm.textContent = 'Showing ' + shownM.toLocaleString() + ' of ' + filteredDeals.length.toLocaleString() + ' deals';
}

/* ── MODAL ───────────────────────────────────────────────────── */
function openModal(deal) {
  if (!deal) return;
  currentDeal = deal;
  populateModal(deal);

  var overlay = el('modalOverlay');
  if (overlay) {
    overlay.classList.add('open');
    overlay.focus();
  }
  document.body.style.overflow = 'hidden';

  // Push permalink URL so each deal is directly shareable
  var slug = '/deal/' + deal.id;
  history.pushState({ dealId: deal.id }, deal.headline || 'Deal', slug);
  document.title = (deal.headline || 'Deal') + ' | mergers.news';
}

function closeModal() {
  var overlay = el('modalOverlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  currentDeal = null;
  history.pushState(null, 'mergers.news — Global M&A Intelligence', '/');
  document.title = 'mergers.news — Global M&A Deal Intelligence';
}

/* ── SECTOR INFERENCE FROM KEYWORDS ─────────────────────── */
function inferSector(d) {
  var text = ((d.headline || '') + ' ' + (d.acquirer || '') + ' ' + (d.target || '') + ' ' + (d.body || '')).toLowerCase();
  if (/software|tech|cloud|ai |saas|semiconductor|cyber|digital|internet|data|platform|fintech/.test(text)) return 'Technology';
  if (/pharma|biotech|therapeutics|medical|drug|clinical|hospital|health|bioscience|oncology|life science/.test(text)) return 'Healthcare';
  if (/bank|insurance|financial|capital|investment|asset management|payment|credit|mortgage|brokerage|wealth/.test(text)) return 'Financial Services';
  if (/energy|oil|gas|petroleum|power|utility|renewable|solar|wind|pipeline|refin/.test(text)) return 'Energy';
  if (/telecom|wireless|broadband|cable|satellite|carrier|spectrum/.test(text)) return 'Telecommunications';
  if (/media|entertainment|publishing|broadcast|streaming|content|studio|gaming/.test(text)) return 'Media';
  if (/retail|consumer|restaurant|food|beverage|apparel|grocery|brand|fashion/.test(text)) return 'Consumer';
  if (/manufactur|industrial|aerospace|defense|automotive|machinery|chemical|material|construction/.test(text)) return 'Industrials';
  if (/real estate|reit|property|realty/.test(text)) return 'Real Estate';
  return d.sector || 'Merger & Acquisition';
}

function populateModal(d) {
  // Eyebrow badges
  var eyebrow = el('modalEyebrow');
  if (eyebrow) {
    var sc = 'badge-' + (d.status || 'rumored').toLowerCase();
    eyebrow.innerHTML =
      '<span class="badge ' + sc + '">' + esc(d.status || 'Unknown') + '</span>' +
      (d.dealType ? '<span class="badge" style="background:var(--bg5);border:1px solid var(--border2);color:var(--muted);margin-left:6px">' + esc(d.dealType) + '</span>' : '') +
      (d.sector   ? '<span class="badge" style="background:var(--bg5);border:1px solid var(--border2);color:var(--muted);margin-left:6px">' + esc(d.sector)   + '</span>' : '');
  }

  // Title
  var title = el('modalTitle');
  if (title) title.textContent = d.headline || (d.acquirer + ' acquires ' + d.target);

  // Actions
  var actions = el('modalActions');
  if (actions) {
    var filingUrl = safeUrl(d.sourceUrl || d.edgarUrl || '');
    actions.innerHTML =
      (filingUrl && filingUrl !== '#'
        ? '<a href="' + filingUrl + '" target="_blank" rel="noopener" class="modal-action-btn primary">View SEC Filing ↗</a>'
        : '<span class="modal-action-btn" style="opacity:0.4;cursor:default">No Filing URL</span>') +
      '<button class="modal-action-btn" onclick="shareModal()">Share</button>' +
      '<button class="modal-action-btn" onclick="exportModalCSV()">Export</button>';
  }

  // Stats grid
  var stats = el('modalStats');
  if (stats) {
    var statDefs = [
      { label: 'Deal Value',     value: d.dealValue || 'Undisclosed', green: !!d.dealValue },
      { label: 'Acquirer',       value: d.acquirer  || 'Undisclosed' },
      { label: 'Target',         value: d.target    || 'Undisclosed' },
      { label: 'Date',           value: d.date || String(d.year || 'Unknown') },
      { label: 'Filing Type',    value: getFilingLabel(d) },
      { label: 'Sector',         value: (d.sector && d.sector !== 'Other') ? d.sector : inferSector(d) },
    ];
    if (d.premium) statDefs.push({ label: 'Premium', value: d.premium });
    if (d.perShare) statDefs.push({ label: 'Per Share', value: d.perShare });

    stats.innerHTML = statDefs.map(function(s) {
      return '<div class="modal-stat">' +
        '<div class="modal-stat-label">' + esc(s.label) + '</div>' +
        '<div class="modal-stat-value' + (s.green ? ' green' : '') + '">' + esc(s.value) + '</div>' +
        '</div>';
    }).join('');
  }

  // Timeline
  var timelineItems = el('modalTimelineItems');
  if (timelineItems) {
    var events = [
      { label: 'Announced', date: d.date || String(d.year || ''), done: true },
      { label: 'Filed',     date: d.filingDate || '', done: true },
      { label: 'Approved',  date: '', done: d.status === 'Completed' },
      { label: 'Closed',    date: d.closingDate || (d.status === 'Completed' ? d.date : ''), done: d.status === 'Completed', current: d.status !== 'Completed' }
    ];
    timelineItems.innerHTML = events.map(function(ev) {
      return '<div class="timeline-item ' + (ev.done ? 'done' : '') + (ev.current ? 'current' : '') + '">' +
        '<div class="timeline-dot"></div>' +
        '<div class="timeline-date">' + esc(ev.date || '—') + '</div>' +
        '<div class="timeline-label">' + esc(ev.label) + '</div>' +
      '</div>';
    }).join('');
  }

  // SEC documents
  var docItems = el('modalDocItems');
  if (docItems) {
    var filingUrl = safeUrl(d.sourceUrl || d.edgarUrl || '');
    var filingType = getFilingLabel(d);
    if (filingUrl && filingUrl !== '#') {
      docItems.innerHTML =
        '<div class="modal-doc">' +
          '<div class="modal-doc-icon">📄</div>' +
          '<div class="modal-doc-info">' +
            '<div class="modal-doc-type">' + esc(filingType) + '</div>' +
            '<div class="modal-doc-desc">' + getFilingDesc(d) + '</div>' +
          '</div>' +
          '<a href="' + filingUrl + '" target="_blank" rel="noopener" class="modal-doc-link">' + getFilingSourceLabel(d) + '</a>' +
        '</div>';
    } else {
      docItems.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--muted)">Filing URL not available for this record.</div>';
    }
  }

  // Transaction summary — lead sentence + full body
  var summarySection = el('modalSummarySection');
  var summaryText    = el('modalSummaryText');
  if (summarySection && summaryText) {
    if (d.body && d.body.trim()) {
      var leadHtml = (d.summary && d.summary.trim())
        ? '<p style="margin-bottom:14px;padding:10px 14px;background:var(--bg4);border-left:2px solid var(--red);border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;color:var(--text2)">' + esc(d.summary) + '</p>'
        : '';
      summaryText.innerHTML = leadHtml + d.body.split('\n\n').map(function(para) {
        return '<p style="margin-bottom:10px">' + esc(para.trim()) + '</p>';
      }).join('');
      summarySection.style.display = '';
    } else if (d.summary && d.summary.trim()) {
      summaryText.innerHTML = '<p style="margin-bottom:14px;padding:10px 14px;background:var(--bg4);border-left:2px solid var(--red);border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;color:var(--text2)">' + esc(d.summary) + '</p>';
      summarySection.style.display = '';
    } else if (d.subheadline) {
      summaryText.innerHTML = '<p>' + esc(d.subheadline) + '</p>';
      summarySection.style.display = '';
    } else {
      summarySection.style.display = 'none';
    }
  }

  // Comparable deals
  var compItems = el('modalComparableItems');
  if (compItems) {
    var comps = findComparables(d);
    if (comps.length) {
      compItems.innerHTML = comps.map(function(c) {
        return '<div class="comparable-item" onclick="openModal(allDeals.find(function(x){return x.id===\'' + esc(c.id) + '\';}))">' +
          '<div class="comparable-info">' +
            '<div class="comparable-name">' + esc(c.headline || (c.acquirer + ' / ' + c.target)) + '</div>' +
            '<div class="comparable-meta">' + esc(c.sector || '') + ' · ' + esc(c.date || String(c.year || '')) + '</div>' +
          '</div>' +
          '<span class="comparable-value">' + esc(c.dealValue || '—') + '</span>' +
          '<span class="comparable-arrow">›</span>' +
        '</div>';
      }).join('');
    } else {
      el('modalComparables').style.display = 'none';
    }
  }
}

function getFilingLabel(d) {
  var st = (d.sourceType || d.extractionMethod || '').toLowerCase();
  if (st === 'news_rss')              return 'Press Release';
  if (st === 'eu_merger_registry')    return 'EU Filing';
  if (st === 'asx')                   return 'ASX Filing';
  if (st === 'hkex')                  return 'HKEX Filing';
  if (st === 'sgx')                   return 'SGX Filing';
  if (d.filingType)                   return d.filingType;
  return d.dealType === 'Acquisition' ? 'SC TO-T' : 'DEFM14A';
}

function getFilingSourceLabel(d) {
  var st = (d.sourceType || d.extractionMethod || '').toLowerCase();
  if (st === 'news_rss')              return 'Source ↗';
  if (st === 'eu_merger_registry')    return 'EC ↗';
  if (st === 'asx')                   return 'ASX ↗';
  if (st === 'hkex')                  return 'HKEX ↗';
  if (st === 'sgx')                   return 'SGX ↗';
  return 'EDGAR ↗';
}

function getFilingDesc(d) {
  var label = typeof d === 'string' ? d : getFilingLabel(d);
  var st    = typeof d === 'string' ? '' : (d.sourceType || d.extractionMethod || '').toLowerCase();
  if (st === 'news_rss')           return 'Press release sourced from ' + (d.sourceName || 'newswire') + ' — may require verification';
  if (st === 'eu_merger_registry') return 'European Commission merger registry filing — notified under EU Merger Regulation';
  if (st === 'asx')                return 'ASX market announcement — filed by acquirer or target with the Australian Securities Exchange';
  if (st === 'hkex')               return 'HKEX company announcement — filed with the Hong Kong Stock Exchange';
  if (st === 'sgx')                return 'SGX company announcement — filed with the Singapore Exchange';
  var secDescs = {
    'DEFM14A': 'Definitive merger proxy — filed by target for shareholder approval',
    'SC TO-T':  'Tender offer statement — filed by acquirer making public share offer',
    'S-4':      'Merger registration — stock-for-stock merger consideration',
    'SC 13E-3': 'Going-private transaction — LBO or management buyout'
  };
  return secDescs[label] || 'SEC regulatory filing';
}

function findComparables(d) {
  var sector    = (d.sector || '').toLowerCase();
  var dealValue = parseDealValue(d.dealValue);
  return allDeals.filter(function(c) {
    if (c.id === d.id) return false;
    var sMatch = sector && (c.sector || '').toLowerCase() === sector;
    var vMatch = dealValue > 0;
    if (vMatch) {
      var cv = parseDealValue(c.dealValue);
      vMatch = cv > 0 && cv >= dealValue * 0.3 && cv <= dealValue * 3;
    }
    return sMatch && (vMatch || !dealValue);
  }).slice(0, 4);
}

function shareModal() {
  if (!currentDeal) return;
  var url = window.location.origin + '/deal/' + currentDeal.id;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      var btn = document.querySelector('[onclick="shareModal()"]');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Share'; }, 1800); }
    }).catch(function() { prompt('Copy this link:', url); });
  } else {
    prompt('Copy this link:', url);
  }
}

function exportModalCSV() {
  if (!currentDeal) return;
  var d = currentDeal;
  var csv = 'Headline,Acquirer,Target,Deal Value,Date,Type,Sector,Status,Filing URL\n' +
    [d.headline, d.acquirer, d.target, d.dealValue, d.date || d.year, d.dealType, d.sector, d.status, d.sourceUrl || d.edgarUrl]
    .map(function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; })
    .join(',');
  downloadText(csv, 'deal.csv', 'text/csv');
}

/* ── CSV EXPORT ──────────────────────────────────────────────── */
function exportCSV() {
  if (!filteredDeals.length) return;
  var rows = filteredDeals.map(function(d) {
    return [d.headline, d.acquirer, d.target, d.dealValue, d.date || d.year,
            d.dealType, d.sector, d.status, d.filingType, d.sourceUrl || d.edgarUrl]
      .map(function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; })
      .join(',');
  });
  var csv = 'Headline,Acquirer,Target,Deal Value,Date,Type,Sector,Status,Filing Type,Filing URL\n' + rows.join('\n');
  downloadText(csv, 'mergers-news-deals.csv', 'text/csv');
}

function downloadText(text, filename, mime) {
  var blob = new Blob([text], { type: mime });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── SETUP MODAL CLOSE ───────────────────────────────────────── */
function setupModal() {
  var closeBtn = el('modalClose');
  var overlay  = el('modalOverlay');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay)  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && el('modalOverlay').classList.contains('open')) closeModal();
  });
}

/* ── LOGO ────────────────────────────────────────────────────── */
function setupLogo() {
  var btn = el('logoBtn');
  if (!btn) return;
  btn.addEventListener('click', function() { window.location.href = '/'; });
  btn.addEventListener('keydown', function(e) { if (e.key === 'Enter') window.location.href = '/'; });
}

/* ── URL PARAMS ──────────────────────────────────────────────── */
function handleUrlParams() {
  var params = new URLSearchParams(window.location.search);
  var q = params.get('q');
  if (q) {
    state.search = q.toLowerCase();
    var si = el('searchInput');
    if (si) si.value = q;
  }
  // /deal/{uuid} — open specific deal once data loads
  var m = window.location.pathname.match(/^\/deal\/([a-f0-9-]{30,40})$/i);
  if (m) window._pendingDealId = m[1];
}

/* ── BROWSER BACK/FORWARD ───────────────────────────────────── */
window.addEventListener('popstate', function(e) {
  if (e.state && e.state.dealId) {
    var deal = allDeals.find(function(d) { return d.id === e.state.dealId; });
    if (deal) {
      currentDeal = deal;
      populateModal(deal);
      var ov = el('modalOverlay');
      if (ov) { ov.classList.add('open'); ov.focus(); }
      document.body.style.overflow = 'hidden';
      document.title = (deal.headline || 'Deal') + ' | mergers.news';
    }
  } else {
    var ov = el('modalOverlay');
    if (ov) ov.classList.remove('open');
    document.body.style.overflow = '';
    currentDeal = null;
    document.title = 'mergers.news — Global M&A Deal Intelligence';
  }
});

/* ── INIT ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  startClock();
  updatePadding();
  window.addEventListener('resize', function() {
    updatePadding();
    if (filteredDeals.length) renderDeals();
  });
  setupLogo();
  setupCmd();
  setupHeroSearch();
  setupFilters();
  setupModal();
  handleUrlParams();
  loadDeals();
});

// Expose for inline handlers
window.openModal        = openModal;
window.filterBySector   = filterBySector;
window.filterByType     = filterByType;
window.shareModal       = shareModal;
window.exportModalCSV   = exportModalCSV;
window.allDeals         = allDeals;
