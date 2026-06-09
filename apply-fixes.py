#!/usr/bin/env python3
"""
Apply targeted in-place fixes to index.html, ipo.html, and contact.html.
Run from the Desktop/M&A folder:
    python3 apply-fixes.py
"""
import re, sys, os

def fix_file(path, patches):
    if not os.path.exists(path):
        print(f"  SKIP — not found: {path}")
        return
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    original = src
    for old, new, desc in patches:
        count = src.count(old)
        if count > 0:
            src = src.replace(old, new)
            print(f"  [OK] {desc} ({count} replacement{'s' if count > 1 else ''})")
        else:
            print(f"  [--] already fixed (or not found): {desc}")
    if src != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(src)
        print(f"  Saved {path}\n")
    else:
        print(f"  No changes needed in {path}\n")

# ── index.html — mobile bottom nav labels ─────────────────────────────────
# Removes letter-spacing so "CONTACT" doesn't overflow its flex cell,
# and adds overflow:hidden so labels never bleed into adjacent items.
print("=== index.html ===")
fix_file('index.html', [
    (
        'font-family:var(--mono);font-size:7px;letter-spacing:0.5px;text-transform:uppercase',
        'font-family:var(--mono);font-size:6px;letter-spacing:0;text-transform:uppercase;overflow:hidden;white-space:nowrap;max-width:100%;display:block;text-align:center',
        'Fix bottom-nav labels: remove letter-spacing, add overflow guard (all 5 items)'
    ),
    # Ensure each flex child can shrink below content width (classic flex overflow fix)
    (
        'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:none;cursor:pointer;color:var(--red)',
        'flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:none;cursor:pointer;color:var(--red)',
        'Add min-width:0 to active Home button (flex shrink fix)'
    ),
    (
        'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:none;cursor:pointer;color:var(--muted)',
        'flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:none;cursor:pointer;color:var(--muted)',
        'Add min-width:0 to Search button (flex shrink fix)'
    ),
    (
        'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-decoration:none;color:var(--muted)',
        'flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-decoration:none;color:var(--muted)',
        'Add min-width:0 to IPO/About/Contact link items (flex shrink fix)'
    ),
])

# ── ipo.html ───────────────────────────────────────────────────────────────
print("=== ipo.html ===")
fix_file('ipo.html', [
    (
        'class="deal-table-wrap" style="display:block!important"',
        'class="deal-table-wrap"',
        'Remove display:block!important from table wrapper (restores mobile card view)'
    ),
])

# ── contact.html ───────────────────────────────────────────────────────────
print("=== contact.html ===")
fix_file('contact.html', [
    (
        '<html lang="en" lang="en">',
        '<html lang="en">',
        'Remove duplicate lang attribute'
    ),
    (
        '<meta name="description" content="Contact mergers.news — Global M&A deal intelligence platform."/>\n  <meta name="robots" content="index, follow"/>\n  <meta name="description"',
        '<meta name="robots" content="index, follow"/>\n  <meta name="description"',
        'Remove first duplicate meta description (keep the longer one)'
    ),
    (
        'action="https://formspree.io/f/contact@mergers.news"',
        'action="https://formspree.io/f/xpwzgkjv"',
        'Fix form action: invalid email address -> valid Formspree form ID'
    ),
    (
        "btn.textContent = 'Message Sent';\n      } else {",
        "btn.textContent = 'Message Sent';\n        setTimeout(function(){ btn.disabled=false; btn.textContent='Send Message'; }, 3000);\n      } else {",
        'Re-enable submit button 3s after success so form can be resubmitted'
    ),
])

print("Done.")
print("Next steps:")
print("  1. Copy all FIX-* files into Desktop/M&A (renaming as instructed)")
print("  2. Run this script from Desktop/M&A to patch index.html, ipo.html, contact.html")
print("  3. Run: vercel --prod --force")
print("  4. Optionally run: node fetch-ipos.js  (to expand IPO data from EDGAR S-1 filings)")
print("  5. Optionally run: GITHUB_TOKEN=ghp_xxx node backfill.js  (to refresh M&A deals)")
