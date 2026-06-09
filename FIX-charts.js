/* ═══════════════════════════════════════════════════════════════
   mergers.news — Charts Engine
   Native Canvas — no external dependencies
   ═══════════════════════════════════════════════════════════════ */

'use strict';

(function() {

/* ── COLOURS ─────────────────────────────────────────────────── */
var C = {
  red:    '#c8102e',
  red2:   'rgba(200,16,46,0.15)',
  green:  '#00d4a8',
  blue:   '#3b82f6',
  muted:  '#353a44',
  muted2: '#1e222a',
  text:   '#6b7280',
  grid:   '#181b21',
  bg:     '#0d0f12',
};

/* ── VOLUME CHART (Bar chart — deals per year) ───────────────── */
window.renderVolumeChart = function(deals) {
  var canvas = document.getElementById('volumeChart');
  if (!canvas || !deals || !deals.length) return;

  // Count deals by year
  var yearCounts = {};
  deals.forEach(function(d) {
    var yr = String(d.year || (d.dateISO ? d.dateISO.slice(0,4) : '') || (d.date ? d.date.slice(-4) : ''));
    var n  = parseInt(yr);
    if (n >= 1993 && n <= 2026) yearCounts[n] = (yearCounts[n] || 0) + 1;
  });

  var years  = [];
  for (var y = 1993; y <= 2026; y++) years.push(y);
  var counts = years.map(function(y) { return yearCounts[y] || 0; });
  var maxVal = Math.max.apply(null, counts) || 1;

  // Canvas setup — use parent width, force reflow first
  var parent = canvas.parentElement;
  var width  = 0;
  var el = canvas;
  while (el && width < 100) { width = el.offsetWidth || el.clientWidth || 0; el = el.parentElement; }
  if (width < 100) width = window.innerWidth > 768 ? 800 : 320;
  width = Math.floor(width) - 2;
  var isMobile = width < 480;
  var height = isMobile ? 180 : 220;
  var dpr    = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width  = width  * dpr;
  canvas.height = height * dpr;
  canvas.style.width  = width  + 'px';
  canvas.style.height = height + 'px';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Responsive padding
  var padL = isMobile ? 36 : 48;
  var padR = 12;
  var padT = isMobile ? 24 : 20;
  var padB = isMobile ? 32 : 40;
  var chartW = width  - padL - padR;
  var chartH = height - padT - padB;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Grid lines
  var gridLines = isMobile ? 3 : 4;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;
  for (var i = 0; i <= gridLines; i++) {
    var gy = padT + chartH - (i / gridLines) * chartH;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + chartW, gy);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = (isMobile ? '8' : '9') + 'px IBM Plex Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / gridLines) * maxVal), padL - 4, gy + 3);
  }

  // Bars
  var barW      = chartW / years.length;
  var barGap    = Math.max(0.5, barW * 0.15);
  var actualBarW = Math.max(1, barW - barGap);

  years.forEach(function(yr, i) {
    var count  = counts[i];
    var barH   = count > 0 ? Math.max(2, (count / maxVal) * chartH) : 0;
    var x      = padL + i * barW + barGap / 2;
    var y      = padT + chartH - barH;
    var isRecent = yr >= 2020;

    if (barH === 0) return;

    var grad = ctx.createLinearGradient(0, y, 0, y + barH);
    if (isRecent) {
      grad.addColorStop(0, 'rgba(200,16,46,0.95)');
      grad.addColorStop(1, 'rgba(200,16,46,0.4)');
    } else {
      grad.addColorStop(0, 'rgba(70,80,100,0.9)');
      grad.addColorStop(1, 'rgba(30,34,42,0.5)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, actualBarW, barH);
  });

  // Axis line
  ctx.strokeStyle = C.muted;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  // Year labels
  var labelInterval = isMobile ? 10 : 5;
  years.forEach(function(yr, i) {
    var showLabel = (yr % labelInterval === 0) || yr === 1993 || yr === 2026;
    if (!showLabel) return;
    var x = padL + i * barW + actualBarW / 2;
    ctx.fillStyle  = C.text;
    ctx.font       = (isMobile ? '7' : '9') + 'px IBM Plex Mono, monospace';
    ctx.textAlign  = 'center';
    ctx.fillText(yr, x, height - padB + (isMobile ? 14 : 16));
  });

  // Peak annotation
  var peakIdx   = counts.indexOf(Math.max.apply(null, counts));
  var peakYear  = years[peakIdx];
  var peakCount = counts[peakIdx];
  var px = padL + peakIdx * barW + barW / 2;
  var py = padT + chartH - (peakCount / maxVal) * chartH - 6;
  ctx.fillStyle  = C.red;
  ctx.font       = 'bold ' + (isMobile ? '7' : '9') + 'px IBM Plex Mono, monospace';
  ctx.textAlign  = 'center';
  ctx.fillText('PEAK ' + peakYear, px, py);

  // Tooltip (desktop only)
  if (!isMobile) {
    setupChartTooltip(canvas, years, counts, padL, padT, padR, padB, chartW, chartH, barW, dpr);
  }
};

function setupChartTooltip(canvas, years, counts, padL, padT, padR, padB, chartW, chartH, barW, dpr) {
  var tooltip = document.getElementById('chartTooltip');
  if (!tooltip) return;

  // Fixed positioning works regardless of container structure
  tooltip.style.position = 'fixed';

  canvas.addEventListener('mousemove', function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx   = e.clientX - rect.left;
    var idx  = Math.floor((mx - padL) / barW);
    if (idx < 0 || idx >= years.length) {
      tooltip.style.display = 'none'; return;
    }
    var yr    = years[idx];
    var count = counts[idx];
    tooltip.style.display = '';
    tooltip.style.left    = (e.clientX + 10) + 'px';
    tooltip.style.top     = (e.clientY - 40) + 'px';
    tooltip.innerHTML =
      '<div class="chart-tooltip-label">' + yr + '</div>' +
      '<div class="chart-tooltip-value">' + count.toLocaleString() + '</div>' +
      '<div class="chart-tooltip-sub">deals tracked</div>';
  });
  canvas.addEventListener('mouseleave', function() {
    tooltip.style.display = 'none';
  });
}

/* ── CHART VIEW TOGGLE ───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  var btns = document.querySelectorAll('[data-chart-view]');
  btns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      btns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (window.allDeals && window.allDeals.length) {
        window.renderVolumeChart(window.allDeals);
      }
    });
  });

  // Redraw chart on resize
  var resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      if (window.allDeals && window.allDeals.length) {
        window.renderVolumeChart(window.allDeals);
      }
    }, 200);
  });
});

})();
