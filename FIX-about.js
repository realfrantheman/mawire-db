var logoBtn = document.getElementById('logoBtn');
if (logoBtn) {
  logoBtn.addEventListener('click', function(){ window.location.href = '/'; });
  logoBtn.addEventListener('keydown', function(e){ if(e.key==='Enter') window.location.href='/'; });
}
var el = document.getElementById('liveClock');
if (el) {
  function tick(){ el.textContent = new Date().toUTCString().split(' ')[4]+' UTC'; }
  tick(); setInterval(tick,1000);
}
function pad(){ var h=document.getElementById('siteHeader'),m=document.getElementById('mainContent'); if(h&&m) m.style.paddingTop=(h.offsetHeight+28+12)+'px'; }
pad(); setTimeout(pad,200); setTimeout(pad,600); window.addEventListener('resize',pad);
