/*
  Drop-in replacement for the inline script block in ipo.html.

  WHAT CHANGED vs the original:
    1. Removed display:block!important on .deal-table-wrap  (already patched by apply-fixes.py)
    2. Added loadDynamicIPOs() — fetches ipos.json from mawire-db and merges with
       the hardcoded IPO_COMPANIES list so the page grows automatically.
    3. Notes truncation fixed: slice(0,90) → slice(0,120) + word-boundary clip.

  HOW TO USE:
    After running apply-fixes.py AND fetch-ipos.js, replace the entire <script> block
    at the bottom of ipo.html's <body> (from "// ── BOOT" to the end </script>) with
    this file's contents.

    Or, more precisely, just add the loadDynamicIPOs call inside the existing init()
    function in ipo.html — instructions at the bottom of this file.
*/

// ── BOOT ─────────────────────────────────────────────────
var _cl = document.getElementById('liveClock');
if (_cl) { function _tick(){ _cl.textContent = new Date().toUTCString().split(' ')[4]+' UTC'; } _tick(); setInterval(_tick,1000); }
var _lb = document.getElementById('logoBtn');
if (_lb) { _lb.addEventListener('click', function(){ window.location.href='/'; }); _lb.addEventListener('keydown',function(e){if(e.key==='Enter')window.location.href='/'; }); }
function _pad(){ var h=document.getElementById('siteHeader'),m=document.getElementById('mainContent'); if(h&&m) m.style.paddingTop=(h.offsetHeight+28+12)+'px'; }
_pad(); setTimeout(_pad,300); window.addEventListener('resize',_pad);

// ── STATUS STYLES ─────────────────────────────────────────
var STATUS_STYLES = {
  's1':        {bg:'rgba(59,130,246,0.12)',  color:'#3b82f6', border:'rgba(59,130,246,0.35)'},
  'expected':  {bg:'rgba(245,158,11,0.12)',  color:'#f59e0b', border:'rgba(245,158,11,0.35)'},
  'rumored':   {bg:'rgba(107,114,128,0.12)', color:'#9ca3af', border:'rgba(107,114,128,0.35)'},
  'completed': {bg:'rgba(0,212,168,0.12)',   color:'#00d4a8', border:'rgba(0,212,168,0.35)'},
};

// ── IPO DATA (hardcoded seed) ─────────────────────────────
var IPO_COMPANIES = [
  {name:'Klarna',         sector:'Fintech',     valuation:'$15B',   status:'s1',        statusLabel:'S-1 Filed',  exchange:'NYSE',      expected:'2026',       notes:'Buy-now-pay-later leader. Filed S-1 with NYSE. Revenue $2.8B in 2024.',                                     tags:['fintech']},
  {name:'Stripe',         sector:'Fintech',     valuation:'$70B',   status:'expected',  statusLabel:'Expected',   exchange:'NASDAQ',    expected:'2026',       notes:'Global payments infrastructure. Last valued at $70B. IPO widely anticipated.',                               tags:['fintech']},
  {name:'Databricks',     sector:'Technology',  valuation:'$62B',   status:'expected',  statusLabel:'Expected',   exchange:'NASDAQ',    expected:'2026',       notes:'Data and AI platform. Raised $10B at $62B valuation in 2024.',                                              tags:['tech']},
  {name:'Chime',          sector:'Fintech',     valuation:'$25B',   status:'s1',        statusLabel:'S-1 Filed',  exchange:'NASDAQ',    expected:'2026',       notes:'Largest US neobank. Filed confidential S-1. 22M+ customers.',                                               tags:['fintech']},
  {name:'Discord',        sector:'Technology',  valuation:'$15B',   status:'expected',  statusLabel:'Expected',   exchange:'NYSE',      expected:'2026',       notes:'Gaming and community platform. 500M+ registered users.',                                                    tags:['tech','consumer']},
  {name:'Figma',          sector:'Technology',  valuation:'$12.5B', status:'expected',  statusLabel:'Expected',   exchange:'NASDAQ',    expected:'2026',       notes:'Collaborative design platform. Adobe acquisition blocked at $20B.',                                          tags:['tech']},
  {name:'Plaid',          sector:'Fintech',     valuation:'$13B',   status:'rumored',   statusLabel:'Rumored',    exchange:'NASDAQ',    expected:'2026-2027',  notes:'Financial data network. Visa acquisition blocked at $5.3B in 2021.',                                        tags:['fintech']},
  {name:'Shein',          sector:'Consumer',    valuation:'$66B',   status:'s1',        statusLabel:'S-1 Filed',  exchange:'LSE',       expected:'2026',       notes:'Fast fashion giant. Filed for London listing after US regulatory hurdles.',                                  tags:['consumer']},
  {name:'Anduril',        sector:'Technology',  valuation:'$28B',   status:'rumored',   statusLabel:'Rumored',    exchange:'—',         expected:'2027+',      notes:'Defense technology company. Raised $1.5B in 2024. IPO not imminent.',                                       tags:['tech']},
  {name:'Kraken',         sector:'Fintech',     valuation:'$20B',   status:'expected',  statusLabel:'Expected',   exchange:'NASDAQ',    expected:'2026',       notes:'Major crypto exchange. Eyeing public markets as crypto regulatory clarity improves.',                       tags:['fintech']},
  {name:'Canva',          sector:'Technology',  valuation:'$26B',   status:'rumored',   statusLabel:'Rumored',    exchange:'ASX/NYSE',  expected:'2026-2027',  notes:'Design platform with 170M+ users globally. Profitable since 2021.',                                        tags:['tech']},
  {name:'SpaceX',         sector:'Technology',  valuation:'$350B',  status:'rumored',   statusLabel:'Rumored',    exchange:'—',         expected:'Unknown',    notes:'Elon Musk has stated no near-term IPO plans. Starlink subsidiary may list separately.',                     tags:['tech']},
  {name:'Waymo',          sector:'Technology',  valuation:'$45B',   status:'rumored',   statusLabel:'Rumored',    exchange:'—',         expected:'Unknown',    notes:'Alphabet autonomous driving unit. Raised $5.6B externally in 2024.',                                       tags:['tech']},
  {name:'Epic Games',     sector:'Consumer',    valuation:'$31.5B', status:'rumored',   statusLabel:'Rumored',    exchange:'—',         expected:'Unknown',    notes:'Fortnite maker. CEO Tim Sweeney has resisted IPO, prefers independence.',                                   tags:['tech','consumer']},
  {name:'Impossible Foods',sector:'Consumer',   valuation:'$7B',    status:'rumored',   statusLabel:'Rumored',    exchange:'NASDAQ',    expected:'2026-2027',  notes:'Plant-based meat company. Multiple IPO attempts delayed due to market conditions.',                         tags:['consumer']},
  {name:'Medline',        sector:'Healthcare',  valuation:'$34B',   status:'expected',  statusLabel:'Expected',   exchange:'NYSE',      expected:'2026',       notes:'Private medical supply giant. PE-backed. Filed confidential S-1.',                                          tags:['tech']},
  {name:'SailPoint',      sector:'Technology',  valuation:'$11.5B', status:'s1',        statusLabel:'S-1 Filed',  exchange:'NYSE',      expected:'2025',       notes:'Identity security platform. Taken private by Thoma Bravo, now re-listing.',                                tags:['tech']},
  {name:'Cerebras',       sector:'Technology',  valuation:'$8.7B',  status:'s1',        statusLabel:'S-1 Filed',  exchange:'NASDAQ',    expected:'2025-2026',  notes:'AI chip maker. Filed S-1. Faces national security review due to Saudi investment.',                         tags:['tech']},
  {name:'CoreWeave',      sector:'Technology',  valuation:'$23B',   status:'completed', statusLabel:'Completed',  exchange:'NASDAQ',    expected:'Mar 2025',   notes:'AI cloud computing. IPO completed March 2025 raising $1.5B.',                                              tags:['tech']},
  {name:'Reddit',         sector:'Consumer',    valuation:'$10B',   status:'completed', statusLabel:'Completed',  exchange:'NYSE',      expected:'Mar 2024',   notes:'Social media platform. IPO completed March 2024. Listed at $34/share.',                                    tags:['tech','consumer']},
];

// ── DYNAMIC IPO LOADER ────────────────────────────────────
// Fetches ipos.json from mawire-db (populated by fetch-ipos.js)
// and merges with the hardcoded list above.
function loadDynamicIPOs(callback) {
  var url = 'https://raw.githubusercontent.com/realfrantheman/mawire-db/main/ipos.json?t=' + Date.now();
  fetch(url)
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(dynamic) {
      if (!Array.isArray(dynamic) || !dynamic.length) return callback(IPO_COMPANIES);

      // Build lookup of hardcoded names (normalised)
      var seen = new Set(IPO_COMPANIES.map(function(c) {
        return c.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
      }));

      // Convert dynamic entries to IPO_COMPANIES format and deduplicate
      var extras = dynamic.filter(function(c) {
        var key = (c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(function(c) {
        return {
          name:        c.name,
          sector:      c.sector      || 'Technology',
          valuation:   c.valuation   || '—',
          status:      c.status      || 'expected',
          statusLabel: c.statusLabel || 'Expected',
          exchange:    c.exchange    || '—',
          expected:    c.expected    || '2025-2026',
          notes:       c.notes       || c.name + ' filed an S-1 with the SEC.',
          tags:        c.tags        || ['tech'],
        };
      });

      // Keep hardcoded 20 at the top; EDGAR additions follow
      callback(IPO_COMPANIES.concat(extras));
    })
    .catch(function() { callback(IPO_COMPANIES); });
}

// ── RENDER TABLE ──────────────────────────────────────────
function renderIPOTable(companies) {
  // Desktop table
  var tbody = document.getElementById('ipoList');
  if (tbody) {
    if (!companies || companies.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted);font-family:var(--mono);font-size:11px">No companies match this filter</td></tr>';
    } else {
      tbody.innerHTML = companies.map(function(c, i) {
        var st = STATUS_STYLES[c.status] || STATUS_STYLES['rumored'];
        return '<tr tabindex="0" data-idx="' + i + '" style="cursor:pointer">' +
          '<td><strong style="color:#fff;font-size:13px;font-family:var(--sans)">' + c.name + '</strong></td>' +
          '<td style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + c.sector + '</td>' +
          '<td style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green)">' + c.valuation + '</td>' +
          '<td><span style="display:inline-flex;align-items:center;font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + '">' + c.statusLabel + '</span></td>' +
          '<td style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + c.exchange + '</td>' +
          '<td style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + c.expected + '</td>' +
          '<td style="font-size:12px;color:var(--text2);line-height:1.4">' + c.notes + '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('tr[data-idx]').forEach(function(row) {
        var idx = parseInt(row.dataset.idx);
        var company = companies[idx];
        row.addEventListener('click', function() { openIPOModal(company); });
        row.addEventListener('keydown', function(e) { if (e.key === 'Enter') openIPOModal(company); });
      });
    }
  }

  // Mobile cards — fixed: notes clipped at word boundary, not mid-word
  var mobile = document.getElementById('ipoCardsMobile');
  if (mobile) {
    var isMobile = window.innerWidth <= 768;
    mobile.style.display = isMobile ? 'block' : 'none';
    if (isMobile) {
      mobile.innerHTML = (companies || []).map(function(c, i) {
        var st = STATUS_STYLES[c.status] || STATUS_STYLES['rumored'];
        // Clip notes at word boundary (not mid-word)
        var notesFull = c.notes || '';
        var notesClip = notesFull.length > 120
          ? notesFull.slice(0, notesFull.lastIndexOf(' ', 120)) + '…'
          : notesFull;
        return '<div data-idx="' + i + '" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:10px;cursor:pointer">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
            '<span style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase">' + c.sector + '</span>' +
            '<span style="font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + '">' + c.statusLabel + '</span>' +
          '</div>' +
          '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">' + c.name + '</div>' +
          '<div style="font-size:11px;color:var(--text2);line-height:1.5;margin-bottom:10px">' + notesClip + '</div>' +
          '<div style="display:flex;justify-content:space-between">' +
            '<span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--green)">' + c.valuation + '</span>' +
            '<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + c.exchange + ' · ' + c.expected + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      mobile.querySelectorAll('[data-idx]').forEach(function(card) {
        var idx = parseInt(card.dataset.idx);
        var company = companies[idx];
        card.addEventListener('click', function() { openIPOModal(company); });
      });
    }
  }
}

// ── MODAL ─────────────────────────────────────────────────
function openIPOModal(c) {
  if (!c) return;
  var overlay = document.getElementById('ipoModalOverlay');
  var content = document.getElementById('ipoModalContent');
  if (!overlay || !content) return;
  var st = STATUS_STYLES[c.status] || STATUS_STYLES['rumored'];

  var sourceLink = c.sourceUrl
    ? '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)"><a href="' + c.sourceUrl + '" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:9px;color:var(--red);letter-spacing:1px;text-transform:uppercase">View SEC Filing →</a></div>'
    : '';

  content.innerHTML =
    '<span style="display:inline-flex;font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:2px;background:' + st.bg + ';color:' + st.color + ';border:1px solid ' + st.border + ';margin-bottom:16px">' + c.statusLabel + '</span>' +
    '<h2 style="font-family:var(--serif);font-size:26px;font-weight:900;color:#fff;margin-bottom:6px;line-height:1.2">' + c.name + '</h2>' +
    '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:24px;letter-spacing:1px">' + c.sector + ' · ' + c.exchange + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">' +
      '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Valuation</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:var(--green)">' + c.valuation + '</div></div>' +
      '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Exchange</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:#fff">' + c.exchange + '</div></div>' +
      '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Expected</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:#fff">' + c.expected + '</div></div>' +
      '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:14px"><div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Status</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;color:' + st.color + '">' + c.statusLabel + '</div></div>' +
    '</div>' +
    '<div style="font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">Company Overview</div>' +
    '<p style="font-size:13px;color:var(--text2);line-height:1.75;margin-top:10px">' + c.notes + '</p>' +
    sourceLink;

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

document.getElementById('ipoModalClose').addEventListener('click', function() {
  document.getElementById('ipoModalOverlay').style.display = 'none';
  document.body.style.overflow = '';
});
document.getElementById('ipoModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) { this.style.display = 'none'; document.body.style.overflow = ''; }
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var ov = document.getElementById('ipoModalOverlay');
    if (ov) { ov.style.display = 'none'; document.body.style.overflow = ''; }
  }
});

// ── FILTERS ───────────────────────────────────────────────
var _currentList = IPO_COMPANIES;
document.getElementById('ipoFilters').addEventListener('click', function(e) {
  var pill = e.target.closest('.filter-pill');
  if (!pill) return;
  document.querySelectorAll('#ipoFilters .filter-pill').forEach(function(p) { p.classList.remove('active'); });
  pill.classList.add('active');
  var filter = pill.dataset.ipoFilter;
  var filtered = filter === 'all'
    ? _currentList
    : _currentList.filter(function(c) {
        return c.status === filter || (c.tags && c.tags.indexOf(filter) !== -1);
      });
  renderIPOTable(filtered);
});

// ── INIT ──────────────────────────────────────────────────
function init() {
  // First render immediately with hardcoded data, then enhance with EDGAR data
  renderIPOTable(IPO_COMPANIES);

  loadDynamicIPOs(function(merged) {
    _currentList = merged;
    // Only re-render if we actually got more companies
    if (merged.length > IPO_COMPANIES.length) {
      renderIPOTable(merged);
      // Update "Companies Tracked" stat counter
      var statEl = document.querySelector('.stat-num');
      if (statEl && statEl.textContent === '20') statEl.textContent = merged.length + '+';
    }
  });

  window.addEventListener('resize', function() { renderIPOTable(_currentList); });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(init, 0);
} else {
  document.addEventListener('DOMContentLoaded', init);
}

/*
  ═══════════════════════════════════════════════════════════════
  HOW TO APPLY THIS TO ipo.html:

  1. Open ipo.html in a text editor
  2. Find the line:  // ── BOOT ─────────────────────────────
     (inside the last <script> block near the bottom of <body>)
  3. Delete everything from that line to the closing </script> tag
  4. Paste the ENTIRE content of this file between the <script> and </script> tags
  5. Save — that's it.

  The page will load instantly with the 20 hardcoded companies,
  then silently fetch ipos.json and add any new EDGAR entries.
  ═══════════════════════════════════════════════════════════════
*/
