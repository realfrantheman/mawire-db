/* mergers.news — Charts Engine (native Canvas, no dependencies) */
'use strict';

(function() {
  var C = {
    red: '#c8102e',
    muted: '#353a44',
    text: '#6b7280',
    grid: '#181b21'
  };

  function yearOf(deal) {
    var raw = deal && (deal.year || (deal.dateISO ? String(deal.dateISO).slice(0, 4) : '') || (deal.date ? String(deal.date).slice(-4) : ''));
    var value = parseInt(String(raw || ''), 10);
    return Number.isFinite(value) ? value : null;
  }

  window.renderVolumeChart = function(deals) {
    var canvas = document.getElementById('volumeChart');
    if (!canvas || !Array.isArray(deals) || !deals.length) return;

    var currentYear = new Date().getUTCFullYear();
    var firstYear = 1993;
    var yearCounts = {};
    deals.forEach(function(deal) {
      var year = yearOf(deal);
      if (year !== null && year >= firstYear && year <= currentYear) {
        yearCounts[year] = (yearCounts[year] || 0) + 1;
      }
    });

    var years = [];
    for (var year = firstYear; year <= currentYear; year++) years.push(year);
    var counts = years.map(function(value) { return yearCounts[value] || 0; });
    var maxVal = Math.max.apply(null, counts) || 1;

    var width = 0;
    var element = canvas;
    while (element && width < 100) {
      width = element.offsetWidth || element.clientWidth || 0;
      element = element.parentElement;
    }
    if (width < 100) width = window.innerWidth > 768 ? 800 : 320;
    width = Math.max(100, Math.floor(width) - 2);

    var isMobile = width < 480;
    var height = isMobile ? 180 : 220;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var padL = isMobile ? 36 : 48;
    var padR = 12;
    var padT = isMobile ? 24 : 20;
    var padB = isMobile ? 32 : 40;
    var chartW = width - padL - padR;
    var chartH = height - padT - padB;
    ctx.clearRect(0, 0, width, height);

    var gridLines = isMobile ? 3 : 4;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
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

    var barW = chartW / years.length;
    var barGap = Math.max(0.5, barW * 0.15);
    var actualBarW = Math.max(1, barW - barGap);
    var recentFrom = Math.max(firstYear, currentYear - 6);

    years.forEach(function(value, index) {
      var count = counts[index];
      var barH = count > 0 ? Math.max(2, (count / maxVal) * chartH) : 0;
      if (!barH) return;
      var x = padL + index * barW + barGap / 2;
      var y = padT + chartH - barH;
      var gradient = ctx.createLinearGradient(0, y, 0, y + barH);
      if (value >= recentFrom) {
        gradient.addColorStop(0, 'rgba(200,16,46,0.95)');
        gradient.addColorStop(1, 'rgba(200,16,46,0.4)');
      } else {
        gradient.addColorStop(0, 'rgba(70,80,100,0.9)');
        gradient.addColorStop(1, 'rgba(30,34,42,0.5)');
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, actualBarW, barH);
    });

    ctx.strokeStyle = C.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + chartH);
    ctx.lineTo(padL + chartW, padT + chartH);
    ctx.stroke();

    var labelInterval = isMobile ? 10 : 5;
    years.forEach(function(value, index) {
      if (!(value % labelInterval === 0 || value === firstYear || value === currentYear)) return;
      var x = padL + index * barW + actualBarW / 2;
      ctx.fillStyle = C.text;
      ctx.font = (isMobile ? '7' : '9') + 'px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(value, x, height - padB + (isMobile ? 14 : 16));
    });

    var peakValue = Math.max.apply(null, counts);
    var peakIndex = counts.indexOf(peakValue);
    if (peakIndex >= 0 && peakValue > 0) {
      var peakYear = years[peakIndex];
      var px = padL + peakIndex * barW + barW / 2;
      var py = padT + chartH - (peakValue / maxVal) * chartH - 6;
      ctx.fillStyle = C.red;
      ctx.font = 'bold ' + (isMobile ? '7' : '9') + 'px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PEAK ' + peakYear, px, py);
    }

    if (!isMobile) setupChartTooltip(canvas, years, counts, padL, barW);
  };

  function setupChartTooltip(canvas, years, counts, padL, barW) {
    var tooltip = document.getElementById('chartTooltip');
    if (!tooltip) return;
    tooltip.style.position = 'fixed';
    canvas.onmousemove = function(event) {
      var rect = canvas.getBoundingClientRect();
      var index = Math.floor((event.clientX - rect.left - padL) / barW);
      if (index < 0 || index >= years.length) {
        tooltip.style.display = 'none';
        return;
      }
      tooltip.style.display = '';
      tooltip.style.left = (event.clientX + 10) + 'px';
      tooltip.style.top = (event.clientY - 40) + 'px';
      tooltip.innerHTML = '<div class="chart-tooltip-label">' + years[index] + '</div>' +
        '<div class="chart-tooltip-value">' + counts[index].toLocaleString() + '</div>' +
        '<div class="chart-tooltip-sub">deals tracked</div>';
    };
    canvas.onmouseleave = function() { tooltip.style.display = 'none'; };
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-chart-view]').forEach(function(button) {
      button.addEventListener('click', function() {
        document.querySelectorAll('[data-chart-view]').forEach(function(other) { other.classList.remove('active'); });
        button.classList.add('active');
        if (window.allDeals && window.allDeals.length) window.renderVolumeChart(window.allDeals);
      });
    });

    var timer;
    window.addEventListener('resize', function() {
      clearTimeout(timer);
      timer = setTimeout(function() {
        if (window.allDeals && window.allDeals.length) window.renderVolumeChart(window.allDeals);
      }, 200);
    });
  });
})();
