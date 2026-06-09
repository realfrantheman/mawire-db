#!/usr/bin/env python3
"""Apply canonical bottom nav to all DEPLOY pages."""

import re

STYLE_BLOCK = '''<style>
    .bottom-nav {
      display: none;
      position: fixed;
      bottom: 0; left: 0; right: 0;
      width: 100%;
      background: rgba(7,8,10,0.97);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-top: 1px solid rgba(255,255,255,0.07);
      z-index: 200;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      box-sizing: border-box;
    }
    .bnav-inner {
      display: flex;
      width: 100%;
      height: 58px;
      align-items: stretch;
    }
    .bnav-item {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: none;
      border: none;
      border-top: 2px solid transparent;
      cursor: pointer;
      color: rgba(107,114,128,0.75);
      text-decoration: none;
      transition: color 0.15s, border-color 0.15s;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }
    .bnav-item:active { opacity: 0.6; }
    .bnav-item.active { color: #c8102e; border-top-color: #c8102e; }
    .bnav-icon { width: 19px; height: 19px; flex-shrink: 0; }
    .bnav-label {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 7.5px;
      font-weight: 500;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      line-height: 1;
      white-space: nowrap;
    }
  </style>'''

JS_BLOCK = '''<script>
  (function() {
    var nav = document.querySelector('.bottom-nav');
    if (!nav) return;
    function upd() { nav.style.display = window.innerWidth <= 768 ? 'flex' : 'none'; }
    upd();
    window.addEventListener('resize', upd);
  })();
</script>'''

def nav_html(active):
    home_cls   = ' active' if active == 'home'    else ''
    ipo_cls    = ' active' if active == 'ipo'     else ''
    about_cls  = ' active' if active == 'about'   else ''
    contact_cls= ' active' if active == 'contact' else ''
    return f'''
<!-- ── BOTTOM NAV (mobile) ─────────────────────────────────── -->
<nav class="bottom-nav" aria-label="Mobile navigation">
  {STYLE_BLOCK}
  <div class="bnav-inner">

    <a href="/" class="bnav-item{home_cls}" aria-label="Home">
      <svg class="bnav-icon" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 2.5L2.5 9H4v8.5h4.5V13h3v4.5H16V9h1.5L10 2.5z"/>
      </svg>
      <span class="bnav-label">Home</span>
    </a>

    <a href="/" class="bnav-item" aria-label="Search deals">
      <svg class="bnav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8.5" cy="8.5" r="5"/>
        <line x1="12.5" y1="12.5" x2="17" y2="17"/>
      </svg>
      <span class="bnav-label">Search</span>
    </a>

    <a href="/ipo" class="bnav-item{ipo_cls}" aria-label="IPO Watch">
      <svg class="bnav-icon" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 3.5l6.5 12H3.5L10 3.5z"/>
      </svg>
      <span class="bnav-label">IPO</span>
    </a>

    <a href="/about" class="bnav-item{about_cls}" aria-label="About mergers.news">
      <svg class="bnav-icon" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 2v1h10V6H5zm0 3v1h10V9H5zm0 3v1h6v-1H5z" clip-rule="evenodd"/>
      </svg>
      <span class="bnav-label">About</span>
    </a>

    <a href="/contact" class="bnav-item{contact_cls}" aria-label="Contact">
      <svg class="bnav-icon" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M2.5 3.5l15 6.5-15 6.5V12l10-2-10-2V3.5z"/>
      </svg>
      <span class="bnav-label">Contact</span>
    </a>

  </div>
</nav>
{JS_BLOCK}'''

pages = [
    # (filename, active_item, replace_old_nav)
    ('DEPLOY-ipo.html',                      'ipo',     True),
    ('DEPLOY-about.html',                    'about',   False),
    ('DEPLOY-contact.html',                  'contact', False),
    ('DEPLOY-tender-offers.html',            'home',    False),
    ('DEPLOY-mergers-technology.html',       'home',    False),
    ('DEPLOY-mergers-healthcare.html',       'home',    False),
    ('DEPLOY-mergers-financial-services.html', 'home',  False),
]

for filename, active, replace_old in pages:
    path = f'/home/user/mawire-db/{filename}'
    with open(path, 'r') as f:
        content = f.read()

    new_nav = nav_html(active)

    if replace_old:
        # Remove old bottom nav block and replace
        old = re.search(
            r'<!-- Bottom Nav -->.*?</nav>',
            content, re.DOTALL
        )
        if old:
            content = content[:old.start()] + new_nav.strip() + '\n' + content[old.end():]
            print(f'{filename}: replaced old nav')
        else:
            print(f'{filename}: WARNING — old nav not found, inserting before footer')
            content = content.replace('<footer class="site-footer">', new_nav.strip() + '\n\n<footer class="site-footer">', 1)
    else:
        # Insert before <footer class="site-footer"> (first occurrence)
        marker = '<footer class="site-footer">'
        if marker in content:
            content = content.replace(marker, new_nav.strip() + '\n\n' + marker, 1)
            print(f'{filename}: inserted nav before footer')
        else:
            print(f'{filename}: WARNING — footer marker not found')

    with open(path, 'w') as f:
        f.write(content)

print('Done.')
