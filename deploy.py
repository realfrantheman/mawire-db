#!/usr/bin/env python3
"""
deploy.py — copies FIX-* / DEPLOY-* files from mawire-db
to mawire-platform and mawire-site via the GitHub API.

Requires: GITHUB_TOKEN env var with repo write scope on all three repos.
"""

import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

TOKEN = os.environ.get('GITHUB_TOKEN') or os.environ.get('MAWIRE_TOKEN')
if not TOKEN:
    print('ERROR: set GITHUB_TOKEN or MAWIRE_TOKEN', file=sys.stderr)
    sys.exit(1)

OWNER = 'realfrantheman'

# ── FILE MAPPINGS ─────────────────────────────────────────────────
# (source_file_in_mawire_db, target_repo, target_path)
MAPPINGS = [
    # ── mawire-platform ──────────────────────────────────────────
    ('FIX-scheduler-v2.js',          'mawire-platform', 'scheduler.js'),
    ('FIX-sec-ingestor-index.js',    'mawire-platform', 'services/sec-ingestor/index.js'),
    ('FIX-historical-backfill.js',   'mawire-platform', 'scripts/historical-backfill.js'),
    ('FIX-export-to-github.js',      'mawire-platform', 'scripts/export-to-github.js'),
    ('FIX-eu-ingestor.js',           'mawire-platform', 'services/eu-ingestor/index.js'),
    ('FIX-apac-ingestor.js',         'mawire-platform', 'services/apac-ingestor/index.js'),
    ('FIX-news-ingestor.js',         'mawire-platform', 'services/news-ingestor/index.js'),
    ('FIX-enrich-deals.js',          'mawire-platform', 'scripts/enrich-deals.js'),
    # ── mawire-site ──────────────────────────────────────────────
    ('DEPLOY-index.html',                      'mawire-site', 'index.html'),
    ('DEPLOY-ipo.html',                        'mawire-site', 'ipo.html'),
    ('DEPLOY-about.html',                      'mawire-site', 'about.html'),
    ('DEPLOY-contact.html',                    'mawire-site', 'contact.html'),
    ('DEPLOY-tender-offers.html',              'mawire-site', 'tender-offers.html'),
    ('DEPLOY-mergers-technology.html',         'mawire-site', 'mergers/technology.html'),
    ('DEPLOY-mergers-healthcare.html',         'mawire-site', 'mergers/healthcare.html'),
    ('DEPLOY-mergers-financial-services.html', 'mawire-site', 'mergers/financial-services.html'),
    ('FIX-sw.js',                              'mawire-site', 'sw.js'),
    ('FIX-ipo-dynamic-loader.js',              'mawire-site', 'ipo.js'),
    ('app.js',                                 'mawire-site', 'app.js'),
    ('style.css',                              'mawire-site', 'style.css'),
    ('DEPLOY-vercel.json',                     'mawire-site', 'vercel.json'),
]

# ── GITHUB API HELPERS ────────────────────────────────────────────
def api(path, method='GET', body=None):
    url = 'https://api.github.com' + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json',
        'User-Agent':    'mawire-deploy/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        if e.code == 404:
            return None
        raise RuntimeError(f'GitHub API {method} {path} → {e.code}: {body_text[:200]}')

def get_sha(repo, path):
    result = api(f'/repos/{OWNER}/{repo}/contents/{path}')
    return result['sha'] if result else None

def push_file(repo, path, content_bytes, message, max_retries=3):
    encoded = base64.b64encode(content_bytes).decode()
    for attempt in range(max_retries):
        sha = get_sha(repo, path)
        payload = {'message': message, 'content': encoded}
        if sha:
            payload['sha'] = sha
        try:
            api(f'/repos/{OWNER}/{repo}/contents/{path}', method='PUT', body=payload)
            return
        except RuntimeError as e:
            if '→ 409' in str(e) and attempt < max_retries - 1:
                print(f'  RETRY ({attempt+1}/{max_retries-1}) {repo}/{path} — SHA conflict, re-fetching')
                time.sleep(2 ** attempt)
                continue
            raise

# ── MAIN ──────────────────────────────────────────────────────────
def main():
    ok = err = 0
    for src, repo, dest in MAPPINGS:
        if not os.path.exists(src):
            print(f'  SKIP  {src} (not found)')
            continue
        try:
            with open(src, 'rb') as f:
                content = f.read()
            msg = f'deploy: {src} → {dest}'
            push_file(repo, dest, content, msg)
            print(f'  OK    {repo}/{dest}')
            ok += 1
            time.sleep(0.3)   # avoid secondary rate limits
        except Exception as e:
            print(f'  FAIL  {repo}/{dest}: {e}')
            err += 1

    print(f'\nDone: {ok} deployed, {err} failed.')
    if err:
        sys.exit(1)

if __name__ == '__main__':
    main()
