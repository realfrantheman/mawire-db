#!/usr/bin/env python3
"""Atomic deployment controller for mergers.news.

The mawire-db repository is the release source of truth. This controller creates
one immutable commit per target repository and only advances target main refs
after every commit has been prepared successfully. If any ref update fails,
already-updated repositories are rolled back to their exact previous SHA.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request

TOKEN = os.environ.get('GITHUB_TOKEN') or os.environ.get('MAWIRE_TOKEN')
if not TOKEN:
    raise SystemExit('GITHUB_TOKEN/MAWIRE_TOKEN is required')

OWNER = 'realfrantheman'
MAPPINGS = [
    # Platform runtime
    ('FIX-scheduler-v2.js', 'mawire-platform', 'scheduler.js'),
    ('FIX-sec-ingestor-index.js', 'mawire-platform', 'services/sec-ingestor/index.js'),
    ('FIX-historical-backfill.js', 'mawire-platform', 'scripts/historical-backfill.js'),
    ('FIX-export-to-github.js', 'mawire-platform', 'scripts/export-to-github.js'),
    ('FIX-eu-ingestor.js', 'mawire-platform', 'services/eu-ingestor/index.js'),
    ('FIX-apac-ingestor.js', 'mawire-platform', 'services/apac-ingestor/index.js'),
    ('FIX-news-ingestor.js', 'mawire-platform', 'services/news-ingestor/index.js'),
    ('FIX-gdelt-ingestor.js', 'mawire-platform', 'services/gdelt-ingestor/index.js'),
    ('FIX-deal-extraction.js', 'mawire-platform', 'services/shared/deal-extraction.js'),
    ('FIX-source-url.js', 'mawire-platform', 'services/shared/source-url.js'),
    ('FIX-source-url-backfill.js', 'mawire-platform', 'scripts/source-url-backfill.js'),
    ('FIX-api-service.js', 'mawire-platform', 'services/api/index.js'),
    ('FIX-enrich-deals.js', 'mawire-platform', 'scripts/enrich-deals.js'),
    ('FIX-migrate.js', 'mawire-platform', 'scripts/migrate.js'),

    # Platform schema and migrations
    ('FIX-platform-schema.sql', 'mawire-platform', 'schema.sql'),
    ('FIX-platform-schema.sql', 'mawire-platform', 'database/schema.sql'),
    ('FIX-ingestion-quality-migration.sql', 'mawire-platform', 'database/migrations/20260611_ingestion_quality.sql'),
    ('FIX-ingestion-observability-migration.sql', 'mawire-platform', 'database/migrations/20260617_ingestion_observability.sql'),
    ('FIX-review-queue-health-migration.sql', 'mawire-platform', 'database/migrations/20260625_review_queue_health.sql'),
    ('FIX-platform-hardening-migration.sql', 'mawire-platform', 'database/migrations/20260901_platform_hardening.sql'),

    # Site
    ('DEPLOY-index.html', 'mawire-site', 'index.html'),
    ('DEPLOY-ipo.html', 'mawire-site', 'ipo.html'),
    ('DEPLOY-about.html', 'mawire-site', 'about.html'),
    ('DEPLOY-contact.html', 'mawire-site', 'contact.html'),
    ('DEPLOY-tender-offers.html', 'mawire-site', 'tender-offers.html'),
    ('DEPLOY-mergers-technology.html', 'mawire-site', 'mergers/technology.html'),
    ('DEPLOY-mergers-healthcare.html', 'mawire-site', 'mergers/healthcare.html'),
    ('DEPLOY-mergers-financial-services.html', 'mawire-site', 'mergers/financial-services.html'),
    ('DEPLOY-404.html', 'mawire-site', '404.html'),
    ('DEPLOY-legal-terms.html', 'mawire-site', 'legal/terms.html'),
    ('DEPLOY-legal-privacy.html', 'mawire-site', 'legal/privacy.html'),
    ('DEPLOY-legal-disclaimer.html', 'mawire-site', 'legal/disclaimer.html'),
    ('DEPLOY-monitoring.html', 'mawire-site', 'monitoring.html'),
    ('DEPLOY-manifest.json', 'mawire-site', 'manifest.json'),
    ('DEPLOY-feed.xml', 'mawire-site', 'feed.xml'),
    ('DEPLOY-rss.xml', 'mawire-site', 'rss.xml'),
    ('icon-192.png', 'mawire-site', 'icon-192.png'),
    ('icon-512.png', 'mawire-site', 'icon-512.png'),
    ('FIX-sw.js', 'mawire-site', 'sw.js'),
    ('DEPLOY-cache-control.js', 'mawire-site', 'cache-control.js'),
    ('DEPLOY-sector-deals.js', 'mawire-site', 'sector-deals.js'),
    ('DEPLOY-source-taxonomy.js', 'mawire-site', 'source-taxonomy.js'),
    ('FIX-ipo-dynamic-loader.js', 'mawire-site', 'ipo.js'),
    ('FIX-quality-hardening.js', 'mawire-site', 'quality-hardening.js'),
    ('DEPLOY-charts.js', 'mawire-site', 'charts.js'),
    ('DEPLOY-about.js', 'mawire-site', 'about.js'),
    ('app.js', 'mawire-site', 'app.js'),
    ('style.css', 'mawire-site', 'style.css'),
    ('DEPLOY-vercel.json', 'mawire-site', 'vercel.json'),
]


def api(path, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        'https://api.github.com' + path,
        data=data,
        method=method,
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'mawire-deploy/3.0',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        raise RuntimeError(f'{method} {path} -> {error.code}: {detail}') from error


def validate_mappings():
    seen_destinations = set()
    missing = []
    for source, repo, destination in MAPPINGS:
        key = (repo, destination)
        if key in seen_destinations:
            raise RuntimeError(f'duplicate deployment destination: {repo}/{destination}')
        seen_destinations.add(key)
        if not os.path.isfile(source):
            missing.append(source)
    if missing:
        raise RuntimeError('missing deployment sources: ' + ', '.join(sorted(set(missing))))


def prepare(repo, items):
    ref = api(f'/repos/{OWNER}/{repo}/git/ref/heads/main')
    base = ref['object']['sha']
    commit = api(f'/repos/{OWNER}/{repo}/git/commits/{base}')
    base_tree = commit['tree']['sha']
    entries = []

    for source, destination in items:
        with open(source, 'rb') as handle:
            raw = handle.read()
        blob = api(
            f'/repos/{OWNER}/{repo}/git/blobs',
            'POST',
            {'content': base64.b64encode(raw).decode(), 'encoding': 'base64'},
        )
        entries.append({'path': destination, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})

    tree = api(
        f'/repos/{OWNER}/{repo}/git/trees',
        'POST',
        {'base_tree': base_tree, 'tree': entries},
    )
    new_sha = api(
        f'/repos/{OWNER}/{repo}/git/commits',
        'POST',
        {
            'message': 'deploy: atomic platform quality hardening release',
            'tree': tree['sha'],
            'parents': [base],
        },
    )['sha']
    return {'repo': repo, 'base': base, 'new': new_sha, 'count': len(entries)}


def update(plan, sha, force=False):
    api(
        f"/repos/{OWNER}/{plan['repo']}/git/refs/heads/main",
        'PATCH',
        {'sha': sha, 'force': force},
    )


def main():
    validate_mappings()
    grouped = {}
    for source, repo, destination in MAPPINGS:
        grouped.setdefault(repo, []).append((source, destination))

    # Prepare every target commit before changing any target ref.
    plans = [prepare(repo, items) for repo, items in grouped.items()]
    updated = []
    try:
        for plan in plans:
            update(plan, plan['new'])
            updated.append(plan)
            print(f"OK {plan['repo']} {plan['count']} files -> {plan['new'][:12]}")
    except Exception:
        for plan in reversed(updated):
            try:
                update(plan, plan['base'], True)
                print(f"ROLLBACK {plan['repo']} -> {plan['base'][:12]}")
            except Exception as rollback_error:
                print(f"ROLLBACK FAILED {plan['repo']}: {rollback_error}", file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
