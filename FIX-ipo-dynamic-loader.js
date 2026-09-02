/* mergers.news — authoritative IPO lifecycle loader */
'use strict';

(function () {
  var DATA_URL = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/ipos.json';
  var _currentList = [];
  var _loadError = null;

  var STATUS_STYLES = {
    priced:    {bg:'rgba(0,212,168,0.12)', color:'#00d4a8', border:'rgba(0,212,168,0.35)'},
    amended:   {bg:'rgba(59,130,246,0.12)', color:'#3b82f6', border:'rgba(59,130,246,0.35)'},
    filed:     {bg:'rgba(59,130,246,0.12)', color:'#3b82f6', border:'rgba(59,130,246,0.35)'},
    delayed:   {bg:'rgba(245,158,11,0.12)', color:'#f59e0b', border:'rgba(245,158,11,0.35)'},
    private:   {bg:'rgba(245,158,11,0.12)', color:'#f59e0b', border:'rgba(245,158,11,0.35)'},
    rumored:   {bg:'rgba(107,114,128,0.12)', color:'#9ca3af', border:'rgba(107,114,128,0.35)'},
    listed:    {bg:'rgba(0,212,168,0.12)', color:'#00d4a8', border:'rgba(0,212,168,0.35)'},
    completed: {bg:'rgba(0,212,168,0.12)', color:'#00d4a8', border:'rgba(0,212,168,0.35)'},
    withdrawn: {bg:'rgba(200,16,46,0.12)', color:'#c8102e', border:'rgba(200,16,46,0.35)'},
    unknown:   {bg:'rgba(107,114,128,0.12)', color:'#9ca3af', border:'rgba(107,114,128,0.35)'}
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHttpUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function statusLabel(record) {
    if (record.statusLabel) return record.statusLabel;
    var labels = {
      priced: 'Priced', amended: 'Amended', filed: 'Filed', delayed: 'Delayed',
      private: 'Private', rumored: 'Rumored', listed: 'Listed', completed: 'Completed',
      withdrawn: 'Withdrawn', unknown: 'Unknown'
    };
    return labels[record.status] || 'Unknown';
  }

  function normalizeRecord(record) {
    var status = String(record.status || 'unknown').toLowerCase();
    var expected = record.expected || record.ipoDate || '—';
    var notes = record.notes || (record.latestUpdateDate
      ? ('Latest verified source update: ' + record.latestUpdateDate + '.')
      : 'Verified IPO lifecycle record.');
    return {
      id: record.id || record.slug || record.cik || record.name,
      name: record.name || record.legalName || 'Unnamed issuer',
      sector: record.sector || 'Other',
      valuation: record.valuation || '—',
      status: status,
      statusLabel: statusLabel({ status: status, statusLabel: record.statusLabel }),
      exchange: record.exchange || '—',
      expected: expected,
      notes: notes,
      tags: Array.isArray(record.tags) ? record.tags : [],
      sourceUrl: safeHttpUrl(record.sourceUrl || (record.sources && record.sources[0] && record.sources[0].url)),
      latestUpdateDate: record.latestUpdateDate || record.filingDate || null,
      filingType: record.filingType || null,
      ticker: record.ticker || null,
      cik: record.cik || null
    };
  }

  function compareRecords(a, b) {
    var priority = { priced:0, amended:1, filed:2, delayed:3, private:4, rumored:5, listed:6, completed:7, withdrawn:8, unknown:9 };
    return (priority[a.status] == null ? 99 : priority[a.status]) - (priority[b.status] == null ? 99 : priority[b.status]) ||
      String(b.latestUpdateDate || '').localeCompare(String(a.latestUpdateDate || '')) ||
      a.name.localeCompare(b.name);
  }

  function loadDynamicIPOs(callback) {
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (!Array.isArray(payload) || !payload.length) throw new Error('IPO artifact is empty or invalid');
        var records = payload.map(normalizeRecord).filter(function (record) {
          return record.name && record.sourceUrl;
        }).sort(compareRecords);
        if (!records.length) throw new Error('IPO artifact contains no publishable records');
        _loadError = null;
        callback(records, null);
      })
      .catch(function (error) {
        _loadError = error;
        callback([], error);
      });
  }

  function emptyMarkup(message) {
    return '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted);font-family:var(--mono);font-size:11px">' + esc(message) + '</td></tr>';
  }

  function renderIPOTable(companies) {
    companies = Array.isArray(companies) ? companies : [];
    var tbody = document.getElementById('ipoList');
    if (tbody) {
      if (!companies.length) {
        tbody.innerHTML = emptyMarkup(_loadError ? 'IPO data is temporarily unavailable. Please retry shortly.' : 'No companies match this filter.');
      } else {
        tbody.innerHTML = companies.map(function (c, i) {
          var st = STATUS_STYLES[c.status] || STATUS_STYLES.unknown;
          return '<tr tabindex="0" data-idx="' + i + '" style="cursor:pointer">' +
            '<td><strong style="color:#fff;font-size:13px;font-family:var(--sans)">' + esc(c.name) + '</strong></td>' +
            '<td style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + esc(c.sector) + '</td>' +
            '<td style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green)">' + esc(c.valuation) + '</td>' +
            '<td><span style="display:inline-flex;align-items:center;font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + '">' + esc(c.statusLabel) + '</span></td>' +
            '<td style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + esc(c.exchange) + '</td>' +
            '<td style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + esc(c.expected) + '</td>' +
            '<td style="font-size:12px;color:var(--text2);line-height:1.4">' + esc(c.notes) + '</td>' +
          '</tr>';
        }).join('');
        tbody.querySelectorAll('tr[data-idx]').forEach(function (row) {
          var company = companies[parseInt(row.dataset.idx, 10)];
          row.addEventListener('click', function () { openIPOModal(company); });
          row.addEventListener('keydown', function (event) { if (event.key === 'Enter') openIPOModal(company); });
        });
      }
    }

    var mobile = document.getElementById('ipoCardsMobile');
    if (mobile) {
      var isMobile = window.innerWidth <= 768;
      mobile.style.display = isMobile ? 'block' : 'none';
      if (isMobile) {
        if (!companies.length) {
          mobile.innerHTML = '<div style="padding:30px;text-align:center;color:var(--muted);font-family:var(--mono);font-size:11px">' +
            esc(_loadError ? 'IPO data is temporarily unavailable. Please retry shortly.' : 'No companies match this filter.') + '</div>';
        } else {
          mobile.innerHTML = companies.map(function (c, i) {
            var st = STATUS_STYLES[c.status] || STATUS_STYLES.unknown;
            var full = c.notes || '';
            var cut = full.length > 120 ? full.slice(0, Math.max(1, full.lastIndexOf(' ', 120))) + '…' : full;
            return '<div data-idx="' + i + '" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:10px;cursor:pointer">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase">' + esc(c.sector) + '</span>' +
              '<span style="font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + '">' + esc(c.statusLabel) + '</span></div>' +
              '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">' + esc(c.name) + '</div>' +
              '<div style="font-size:11px;color:var(--text2);line-height:1.5;margin-bottom:10px">' + esc(cut) + '</div>' +
              '<div style="display:flex;justify-content:space-between"><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--green)">' + esc(c.valuation) + '</span>' +
              '<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + esc(c.exchange) + ' · ' + esc(c.expected) + '</span></div></div>';
          }).join('');
          mobile.querySelectorAll('[data-idx]').forEach(function (card) {
            var company = companies[parseInt(card.dataset.idx, 10)];
            card.addEventListener('click', function () { openIPOModal(company); });
          });
        }
      }
    }
  }

  function openIPOModal(c) {
    if (!c) return;
    var overlay = document.getElementById('ipoModalOverlay');
    var content = document.getElementById('ipoModalContent');
    if (!overlay || !content) return;
    var st = STATUS_STYLES[c.status] || STATUS_STYLES.unknown;
    var sourceLink = c.sourceUrl
      ? '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)"><a href="' + esc(c.sourceUrl) + '" target="_blank" rel="noopener noreferrer" style="font-family:var(--mono);font-size:9px;color:var(--red);letter-spacing:1px;text-transform:uppercase">View Source →</a></div>'
      : '';
    content.innerHTML =
      '<span style="display:inline-flex;font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + ';margin-bottom:16px">' + esc(c.statusLabel) + '</span>' +
      '<h2 style="font-family:var(--serif);font-size:26px;font-weight:900;color:#fff;margin-bottom:6px;line-height:1.2">' + esc(c.name) + '</h2>' +
      '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:24px;letter-spacing:1px">' + esc(c.sector) + ' · ' + esc(c.exchange) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">' +
        '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Valuation</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:var(--green)">' + esc(c.valuation) + '</div></div>' +
        '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Exchange</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:#fff">' + esc(c.exchange) + '</div></div>' +
        '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Expected</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:#fff">' + esc(c.expected) + '</div></div>' +
        '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Status</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:' + st.color + '">' + esc(c.statusLabel) + '</div></div>' +
      '</div>' +
      '<div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">Company Overview</div>' +
      '<p style="font-size:13px;color:var(--text2);line-height:1.75;margin-top:10px">' + esc(c.notes) + '</p>' + sourceLink;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    var overlay = document.getElementById('ipoModalOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  function bindStaticUi() {
    var clock = document.getElementById('liveClock');
    if (clock) {
      function tick() { clock.textContent = new Date().toUTCString().split(' ')[4] + ' UTC'; }
      tick(); setInterval(tick, 1000);
    }
    var logo = document.getElementById('logoBtn');
    if (logo) {
      logo.addEventListener('click', function () { window.location.href = '/'; });
      logo.addEventListener('keydown', function (event) { if (event.key === 'Enter') window.location.href = '/'; });
    }
    function pad() {
      var header = document.getElementById('siteHeader');
      var main = document.getElementById('mainContent');
      if (header && main) main.style.paddingTop = (header.offsetHeight + 40) + 'px';
    }
    pad(); setTimeout(pad, 300); window.addEventListener('resize', pad);

    var close = document.getElementById('ipoModalClose');
    if (close) close.addEventListener('click', closeModal);
    var overlay = document.getElementById('ipoModalOverlay');
    if (overlay) overlay.addEventListener('click', function (event) { if (event.target === overlay) closeModal(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeModal(); });

    var filters = document.getElementById('ipoFilters');
    if (filters) filters.addEventListener('click', function (event) {
      var pill = event.target.closest('.filter-pill');
      if (!pill) return;
      filters.querySelectorAll('.filter-pill').forEach(function (item) { item.classList.remove('active'); });
      pill.classList.add('active');
      var filter = pill.dataset.ipoFilter;
      var filtered = filter === 'all' ? _currentList : _currentList.filter(function (c) {
        return c.status === filter || c.sector.toLowerCase().replace(/[^a-z0-9]/g, '') === String(filter || '').replace(/[^a-z0-9]/g, '') || c.tags.indexOf(filter) !== -1;
      });
      renderIPOTable(filtered);
    });
  }

  function init() {
    bindStaticUi();
    var tbody = document.getElementById('ipoList');
    if (tbody) tbody.innerHTML = emptyMarkup('Loading verified IPO lifecycle data…');
    var stat = document.querySelector('.stat-num');
    if (stat) stat.textContent = '—';
    loadDynamicIPOs(function (records) {
      _currentList = records;
      renderIPOTable(records);
      if (stat) stat.textContent = records.length ? records.length.toLocaleString() : '—';
    });
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { renderIPOTable(_currentList); }, 150);
    });
  }

  window.loadDynamicIPOs = loadDynamicIPOs;
  window.renderIPOTable = renderIPOTable;

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 0);
  else document.addEventListener('DOMContentLoaded', init);
})();
