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
DEPLOY_PLATFORM_FIXES = os.environ.get('DEPLOY_PLATFORM_FIXES') == 'true'

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
    ('FIX-gdelt-ingestor.js',        'mawire-platform', 'services/gdelt-ingestor/index.js'),
    ('FIX-deal-extraction.js',       'mawire-platform', 'services/shared/deal-extraction.js'),
    ('FIX-api-service.js',           'mawire-platform', 'services/api/index.js'),
    ('FIX-platform-schema.sql',      'mawire-platform', 'schema.sql'),
    ('FIX-platform-schema.sql',      'mawire-platform', 'database/schema.sql'),
    ('FIX-ingestion-quality-migration.sql', 'mawire-platform', 'database/migrations/20260611_ingestion_quality.sql'),
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
    ('DEPLOY-404.html',                        'mawire-site', '404.html'),
    ('DEPLOY-legal-terms.html',                'mawire-site', 'legal/terms.html'),
    ('DEPLOY-legal-privacy.html',              'mawire-site', 'legal/privacy.html'),
    ('DEPLOY-legal-disclaimer.html',           'mawire-site', 'legal/disclaimer.html'),
    ('DEPLOY-monitoring.html',                 'mawire-site', 'monitoring.html'),
    ('DEPLOY-manifest.json',                   'mawire-site', 'manifest.json'),
    ('DEPLOY-feed.xml',                        'mawire-site', 'feed.xml'),
    ('DEPLOY-rss.xml',                         'mawire-site', 'rss.xml'),
    ('icon-192.png',                           'mawire-site', 'icon-192.png'),
    ('icon-512.png',                           'mawire-site', 'icon-512.png'),
    ('FIX-sw.js',                              'mawire-site', 'sw.js'),
    ('DEPLOY-cache-control.js',                 'mawire-site', 'cache-control.js'),
    ('DEPLOY-sector-deals.js',                  'mawire-site', 'sector-deals.js'),
    ('DEPLOY-source-taxonomy.js',               'mawire-site', 'source-taxonomy.js'),
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

def push_file(repo, path, content_bytes, message, max_retries=4):
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
            msg = str(e)
            is_last = attempt >= max_retries - 1
            # Retry on SHA conflict (409), transient auth errors (401), rate limits (429/403)
            retryable = any(f'→ {c}' in msg for c in ('401', '403', '409', '429'))
            if retryable and not is_last:
                wait = 2 ** (attempt + 1)   # 2s, 4s, 8s
                print(f'  RETRY ({attempt+1}/{max_retries-1}) {repo}/{path} — {msg[-60:].strip()} — waiting {wait}s')
                time.sleep(wait)
                continue
            raise

# ── MAIN ──────────────────────────────────────────────────────────
def main():
    ok = 0
    site_err = 0      # mawire-site failures → fatal
    platform_err = 0  # mawire-platform failures → warning only

    for src, repo, dest in MAPPINGS:
        if repo == 'mawire-platform' and not DEPLOY_PLATFORM_FIXES:
            print(f'  SKIP  {repo}/{dest} (platform FIX deploy disabled; set DEPLOY_PLATFORM_FIXES=true to override)')
            continue
        if not os.path.exists(src):
            print(f'  SKIP  {src} (not found)')
            continue
        try:
            with open(src, 'rb') as f:
                content = f.read()
            push_file(repo, dest, content, f'deploy: {src} → {dest}')
            print(f'  OK    {repo}/{dest}')
            ok += 1
            time.sleep(0.5)   # avoid secondary rate limits
        except Exception as e:
            print(f'  FAIL  {repo}/{dest}: {e}')
            if repo == 'mawire-site':
                site_err += 1
            else:
                platform_err += 1

    total_err = site_err + platform_err
    print(f'\nDone: {ok} deployed, {total_err} failed'
          + (f' ({site_err} site, {platform_err} platform)' if total_err else '') + '.')

    if platform_err and not site_err:
        print(f'WARNING: {platform_err} mawire-platform file(s) failed — site is healthy.')

    # Only fail the workflow if mawire-site had errors
    if site_err:
        sys.exit(1)

if __name__ == '__main__':
    main()
