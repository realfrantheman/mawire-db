#!/usr/bin/env python3
"""
Apply targeted in-place fixes to ipo.html and contact.html.
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
        if old in src:
            src = src.replace(old, new, 1)
            print(f"  [OK] {desc}")
        else:
            print(f"  [--] already fixed (or not found): {desc}")
    if src != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(src)
        print(f"  Saved {path}")
    else:
        print(f"  No changes needed in {path}")

print("\n=== ipo.html ===")
fix_file('ipo.html', [
    (
        'class="deal-table-wrap" style="display:block!important"',
        'class="deal-table-wrap"',
        'Remove display:block!important from table wrapper (fixes mobile responsive hiding)'
    ),
])

print("\n=== contact.html ===")
fix_file('contact.html', [
    (
        '<html lang="en" lang="en">',
        '<html lang="en">',
        'Remove duplicate lang attribute'
    ),
    (
        '<meta name="description" content="Contact mergers.news — Global M&A deal intelligence platform."/>\n  <meta name="robots" content="index, follow"/>\n  <meta name="description"',
        '<meta name="robots" content="index, follow"/>\n  <meta name="description"',
        'Remove duplicate meta description (keep the longer one)'
    ),
    (
        'action="https://formspree.io/f/contact@mergers.news"',
        'action="https://formspree.io/f/xpwzgkjv"',
        'Fix form action to use valid Formspree ID (not email address)'
    ),
    (
        "btn.textContent = 'Message Sent';\n      } else {",
        "btn.textContent = 'Message Sent';\n        setTimeout(function(){ btn.disabled=false; btn.textContent='Send Message'; }, 3000);\n      } else {",
        'Re-enable submit button 3s after success so form can be resubmitted'
    ),
])

print("\nDone. Copy all FIX-* files to your M&A folder and deploy with: vercel --prod --force\n")
