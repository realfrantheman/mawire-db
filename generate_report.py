#!/usr/bin/env python3
"""Generate mergers.news platform summary PDF."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from datetime import datetime

OUT = '/home/user/mawire-db/mergers-news-platform-summary.pdf'

# ── COLOURS ───────────────────────────────────────────────────────────────────
NAVY   = colors.HexColor('#0f172a')
BLUE   = colors.HexColor('#2563eb')
CYAN   = colors.HexColor('#0ea5e9')
GREEN  = colors.HexColor('#16a34a')
AMBER  = colors.HexColor('#d97706')
RED    = colors.HexColor('#dc2626')
LGRAY  = colors.HexColor('#f1f5f9')
MGRAY  = colors.HexColor('#cbd5e1')
DGRAY  = colors.HexColor('#475569')
WHITE  = colors.white

# ── STYLES ────────────────────────────────────────────────────────────────────
base = getSampleStyleSheet()

def sty(name, parent='Normal', **kw):
    return ParagraphStyle(name, parent=base[parent], **kw)

S = {
    'cover_title': sty('cover_title', fontSize=32, textColor=WHITE,
                        fontName='Helvetica-Bold', alignment=TA_CENTER, leading=38),
    'cover_sub':   sty('cover_sub',   fontSize=13, textColor=CYAN,
                        fontName='Helvetica', alignment=TA_CENTER, leading=18),
    'cover_date':  sty('cover_date',  fontSize=10, textColor=MGRAY,
                        fontName='Helvetica', alignment=TA_CENTER),

    'h1':  sty('h1',  fontSize=18, textColor=NAVY, fontName='Helvetica-Bold',
                spaceBefore=18, spaceAfter=6, leading=22),
    'h2':  sty('h2',  fontSize=13, textColor=BLUE, fontName='Helvetica-Bold',
                spaceBefore=12, spaceAfter=4, leading=16),
    'h3':  sty('h3',  fontSize=11, textColor=DGRAY, fontName='Helvetica-Bold',
                spaceBefore=8,  spaceAfter=3, leading=14),

    'body':   sty('body',   fontSize=9.5, leading=14, spaceAfter=4,
                   fontName='Helvetica', textColor=NAVY),
    'body_j': sty('body_j', fontSize=9.5, leading=14, spaceAfter=4,
                   fontName='Helvetica', textColor=NAVY, alignment=TA_JUSTIFY),
    'small':  sty('small',  fontSize=8.5, leading=12, textColor=DGRAY,
                   fontName='Helvetica', spaceAfter=3),
    'bullet': sty('bullet', fontSize=9.5, leading=14, spaceAfter=3,
                   fontName='Helvetica', textColor=NAVY,
                   leftIndent=14, firstLineIndent=-10),
    'code':   sty('code', fontSize=8, leading=11, fontName='Courier',
                   textColor=colors.HexColor('#1e293b'),
                   backColor=LGRAY, leftIndent=8, rightIndent=8,
                   spaceBefore=4, spaceAfter=4),
    'tag_green': sty('tag_green', fontSize=8, fontName='Helvetica-Bold',
                      textColor=GREEN),
    'tag_amber': sty('tag_amber', fontSize=8, fontName='Helvetica-Bold',
                      textColor=AMBER),
    'tag_red':   sty('tag_red',   fontSize=8, fontName='Helvetica-Bold',
                      textColor=RED),
}

def hr(color=MGRAY, thickness=0.5): return HRFlowable(width='100%', thickness=thickness, color=color, spaceAfter=6, spaceBefore=6)
def sp(h=6): return Spacer(1, h)
def p(text, style='body'): return Paragraph(text, S[style])
def b(text): return Paragraph(f'• &nbsp;{text}', S['bullet'])
def h1(text): return Paragraph(text, S['h1'])
def h2(text): return Paragraph(text, S['h2'])
def h3(text): return Paragraph(text, S['h3'])
def code(text): return Paragraph(text.replace('\n','<br/>').replace(' ','&nbsp;'), S['code'])

TABLE_STYLE = TableStyle([
    ('BACKGROUND',  (0,0),(-1,0), NAVY),
    ('TEXTCOLOR',   (0,0),(-1,0), WHITE),
    ('FONTNAME',    (0,0),(-1,0), 'Helvetica-Bold'),
    ('FONTSIZE',    (0,0),(-1,0), 8.5),
    ('ALIGN',       (0,0),(-1,0), 'CENTER'),
    ('ROWBACKGROUNDS',(0,1),(-1,-1),[WHITE, LGRAY]),
    ('FONTNAME',    (0,1),(-1,-1), 'Helvetica'),
    ('FONTSIZE',    (0,1),(-1,-1), 8.5),
    ('VALIGN',      (0,0),(-1,-1), 'MIDDLE'),
    ('TOPPADDING',  (0,0),(-1,-1), 5),
    ('BOTTOMPADDING',(0,0),(-1,-1), 5),
    ('LEFTPADDING', (0,0),(-1,-1), 6),
    ('RIGHTPADDING',(0,0),(-1,-1), 6),
    ('GRID',        (0,0),(-1,-1), 0.4, MGRAY),
])

def table(data, col_widths):
    t = Table(data, colWidths=col_widths)
    t.setStyle(TABLE_STYLE)
    return t

# ── DOCUMENT ──────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm,
    topMargin=2*cm, bottomMargin=2*cm,
    title='mergers.news Platform Summary',
    author='mergers.news Engineering',
)

W = A4[0] - 4*cm   # usable width
story = []

# ── COVER PAGE ────────────────────────────────────────────────────────────────
cover_bg = Table(
    [[Paragraph('<br/><br/><br/><br/><br/><br/>', S['cover_title'])]],
    colWidths=[W+4*cm], rowHeights=[260]
)
cover_bg.setStyle(TableStyle([
    ('BACKGROUND', (0,0),(-1,-1), NAVY),
    ('LEFTPADDING',(0,0),(-1,-1), 0),
    ('RIGHTPADDING',(0,0),(-1,-1), 0),
    ('TOPPADDING',(0,0),(-1,-1), 0),
    ('BOTTOMPADDING',(0,0),(-1,-1), 0),
]))

story.append(Spacer(1, 2*cm))
story.append(cover_bg)
story.append(sp(20))
story.append(p('mergers.news', 'cover_title'))
story.append(sp(6))
story.append(p('Full Platform Engineering Summary', 'cover_sub'))
story.append(sp(4))
story.append(p('Architecture · Services · Data Flow · Known Issues · Monitoring', 'cover_sub'))
story.append(sp(16))
story.append(p(f'Generated: {datetime.utcnow().strftime("%B %d, %Y — %H:%M UTC")}', 'cover_date'))
story.append(p('Confidential — Internal Use Only', 'cover_date'))
story.append(PageBreak())

# ── 1. PLATFORM OVERVIEW ──────────────────────────────────────────────────────
story.append(h1('1. Platform Overview'))
story.append(hr(BLUE, 1))
story.append(p(
    'mergers.news is a fully automated M&A intelligence platform that ingests merger and acquisition '
    'filings from global regulatory sources, enriches them using AI extraction, deduplicates records, '
    'and publishes them to a static frontend served via Vercel. The system is split across four GitHub '
    'repositories, each with a distinct role.', 'body_j'))
story.append(sp(8))

story.append(table(
    [['Repository', 'Role', 'Runtime', 'Status'],
     ['mawire-db',       'Source of truth, deploy controller', 'GitHub Actions', '✓ Active'],
     ['mawire-platform', 'Backend ingestion pipeline',         'Railway (Node.js)', '✓ Active'],
     ['mawire-site',     'Static frontend',                    'Vercel (CDN)',      '✓ Active'],
     ['mawire-monitor',  'Independent health auditor',         'GitHub Actions',   '✓ Active'],
    ],
    [3.5*cm, 6.5*cm, 4.5*cm, 2.5*cm]
))

story.append(sp(12))
story.append(h2('1.1 Data Flow'))
story.append(p(
    'Data enters the platform through five parallel ingestor services running on mawire-platform. '
    'All ingestors write to a shared PostgreSQL database (Neon serverless). Every two hours the '
    'export script dumps the full deals dataset to deals.json in mawire-db, which Vercel deploys '
    'to the CDN. The frontend fetches this file at page load. Separately, mawire-monitor audits '
    'the database every hour and publishes a health snapshot to mawire-site for the dashboard.', 'body_j'))
story.append(sp(6))
story.append(code(
    'SEC EDGAR / GDELT / EU Registry / APAC Exchanges / News RSS\n'
    '         ↓  (ingested every 30 min – 12 hours)\n'
    '   mawire-platform  →  PostgreSQL (Neon)\n'
    '         ↓  (every 2 hours)\n'
    '   export-to-github.js  →  mawire-db/deals.json  →  mawire-site CDN\n'
    '         ↓  (every 1 hour)\n'
    '   mawire-monitor  →  pie-health.json  →  mergers.news/pie-health.json'
))

story.append(PageBreak())

# ── 2. MAWIRE-DB ─────────────────────────────────────────────────────────────
story.append(h1('2. mawire-db — Source of Truth'))
story.append(hr(BLUE, 1))
story.append(p(
    'All application source code lives in mawire-db. No service runs directly from this repo; '
    'instead, deploy.py copies files to the appropriate target repos whenever a push is made to '
    'main or a claude/** branch.', 'body_j'))

story.append(sp(8))
story.append(h2('2.1 deploy.py'))
story.append(p('Copies FIX-* and DEPLOY-* files to mawire-platform and mawire-site via the GitHub Contents API. '
               'mawire-site failures are fatal (exit 1); mawire-platform failures are warnings only. '
               'SHA-aware: reads existing file SHA before PUT to avoid conflicts. '
               'Retries on 401/403/409/429 with exponential backoff (2s, 4s, 8s).'))
story.append(sp(6))
story.append(h2('2.2 GitHub Actions Workflows'))
story.append(table(
    [['Workflow', 'Trigger', 'Purpose'],
     ['deploy.yml',             'Push to main/claude/**',     'Runs deploy.py — copies all FIX-/DEPLOY- files to target repos'],
     ['auto-backfill.yml',      'Schedule: every 30 min',     'Runs FIX-historical-backfill.js (1993–2024), then exports deals.json'],
     ['refresh-deals.yml',      'Schedule (periodic)',        'Re-exports deals.json from DB to mawire-db'],
     ['historical-backfill.yml','workflow_dispatch (manual)', 'One-shot full historical backfill with configurable year range'],
     ['enrich-deals.yml',       'workflow_dispatch (manual)', 'Runs FIX-enrich-deals.js on pending deals'],
    ],
    [3.5*cm, 4*cm, 9.5*cm]
))

story.append(sp(8))
story.append(h2('2.3 Key Source Files'))
story.append(table(
    [['File', 'Deploys To', 'Description'],
     ['FIX-scheduler-v2.js',       'mawire-platform/scheduler.js',                    'Master cron orchestrator'],
     ['FIX-sec-ingestor-index.js', 'mawire-platform/services/sec-ingestor/index.js',  'SEC EDGAR filing ingestor'],
     ['FIX-news-ingestor.js',      'mawire-platform/services/news-ingestor/index.js', 'RSS news ingestor'],
     ['FIX-eu-ingestor.js',        'mawire-platform/services/eu-ingestor/index.js',   'EU Merger Registry ingestor'],
     ['FIX-apac-ingestor.js',      'mawire-platform/services/apac-ingestor/index.js', 'HKEX/ASX/SGX ingestor'],
     ['FIX-export-to-github.js',   'mawire-platform/scripts/export-to-github.js',     'DB → deals.json export'],
     ['FIX-historical-backfill.js','mawire-platform/scripts/historical-backfill.js',  'Full SEC backfill 1993–present'],
     ['FIX-enrich-deals.js',       'mawire-platform/scripts/enrich-deals.js',         'Deal enrichment script'],
     ['DEPLOY-index.html',         'mawire-site/index.html',                           'Main deal listings page'],
     ['DEPLOY-vercel.json',        'mawire-site/vercel.json',                          'Vercel routing + security headers'],
     ['FIX-sw.js',                 'mawire-site/sw.js',                                'Service worker'],
     ['app.js',                    'mawire-site/app.js',                               'Frontend application logic'],
     ['style.css',                 'mawire-site/style.css',                            'All frontend styles'],
     ['pie-health.json',           'mawire-site/pie-health.json',                      'Health snapshot (updated hourly by monitor)'],
    ],
    [5*cm, 6.5*cm, 5.5*cm]
))

story.append(sp(8))
story.append(h2('2.4 Secrets Required'))
story.append(table(
    [['Secret', 'Used By', 'Scope Required'],
     ['MAWIRE_TOKEN', 'deploy.py, auto-backfill, all workflows', 'repo + workflow (GitHub PAT)'],
     ['DATABASE_URL', 'auto-backfill, historical-backfill, enrich-deals', 'Neon PostgreSQL connection string'],
    ],
    [3.5*cm, 7.5*cm, 6*cm]
))

story.append(PageBreak())

# ── 3. MAWIRE-PLATFORM ───────────────────────────────────────────────────────
story.append(h1('3. mawire-platform — Backend Pipeline'))
story.append(hr(BLUE, 1))
story.append(p(
    'Node.js server running continuously on Railway. The entry point is scheduler.js which '
    'registers all cron jobs using node-cron. Each job uses a flag object to prevent overlapping '
    'runs. Services run as separate modules under ./services/ and scripts run under ./scripts/.', 'body_j'))

story.append(sp(8))
story.append(h2('3.1 Cron Schedule'))
story.append(table(
    [['Service', 'Frequency', 'Source / Target', 'Flag'],
     ['SEC EDGAR ingestor',    'Every 30 min',   'SEC EDGAR EFTS API → PostgreSQL',         'flags.sec'],
     ['GDELT ingestor',        'Every 1 hour',   'GDELT API → PostgreSQL',                  'flags.gdelt'],
     ['News RSS ingestor',     'Every 2 hours',  'RSS feeds → PostgreSQL',                  'flags.news'],
     ['EU Merger Registry',    'Every 12 hours', 'EU Commission API → PostgreSQL',          'flags.eu'],
     ['APAC (HKEX/ASX/SGX)',   'Every 4 hours',  'HK/AU/SG exchange APIs → PostgreSQL',    'flags.apac'],
     ['AI Extraction queue',   'Every 5 min',    'PostgreSQL (needs_review=true) → update', 'flags.extract'],
     ['Deduplication',         'Every 6 hours',  'PostgreSQL → merge near-duplicates',      'flags.dedup'],
     ['GitHub export',         'Every 2 hours',  'PostgreSQL → mawire-db/deals.json',       '(no flag)'],
     ['Stats cache clear',     'Every 1 hour',   'DELETE FROM stats_cache WHERE key=api_stats','(no flag)'],
    ],
    [4*cm, 2.8*cm, 6.5*cm, 2.5*cm]
))

story.append(sp(8))
story.append(h2('3.2 Startup Sequence'))
story.append(p('On startup, the scheduler fires staggered initialisation runs to warm up the pipeline:'))
story.append(table(
    [['Delay', 'Service'],
     ['2 seconds',  'SEC EDGAR ingestor'],
     ['15 seconds', 'News RSS ingestor'],
     ['30 seconds', 'EU Merger Registry ingestor'],
     ['45 seconds', 'APAC ingestor'],
     ['60 seconds', 'GitHub export (deals.json)'],
    ],
    [3*cm, 14*cm]
))

story.append(sp(8))
story.append(h2('3.3 Database Schema (PostgreSQL / Neon)'))
story.append(table(
    [['Table', 'Purpose', 'Key Columns'],
     ['deals',                'Core deal records',           'id, acquirer_id, target_id, headline, deal_type, status, deal_value, sector, region, country, source_confidence, needs_review, announcement_date'],
     ['companies',            'Acquirer/target entities',    'id, name, normalized_name, cik, sic'],
     ['filings',              'SEC filing records',          'id, deal_id, company_id, filing_type, accession_no, cik, edgar_url, filing_date'],
     ['deal_sources',         'Per-deal source records',     'id, deal_id, source_type, source_name, source_url, raw_content'],
     ['stats_cache',          'Key/value cache',             'key, value, updated_at (includes last_github_export timestamp)'],
     ['pie_checks',           'PIE health check results',    'id, check_name, category, status, score, message, detail (jsonb), checked_at'],
     ['pie_alerts',           'Active/resolved alerts',      'id, alert_key, severity, title, description, first_seen, last_seen, resolved_at, auto_remedied'],
     ['pie_metrics',          'Time-series metric values',   'id, metric_name, value, unit, recorded_at'],
     ['pie_health_snapshots', 'Hourly health snapshots',     'id, overall_score, pass_count, warn_count, fail_count, active_alerts, snapshot (jsonb), taken_at'],
    ],
    [3.8*cm, 3.8*cm, 9.4*cm]
))

story.append(sp(8))
story.append(h2('3.4 AI Extraction Service'))
story.append(p(
    'The extraction queue runs every 5 minutes and processes up to 20 deals per cycle where '
    'needs_review=true and source_confidence < 0.85. It pulls the filing\'s raw_content, '
    'truncates to 10,000 characters, and calls the AI extractor to populate headline, deal_value, '
    'per_share_value, premium_pct, announcement_date, and sector. Confidence is capped at 0.95. '
    'After processing, needs_review is set to false.', 'body_j'))

story.append(sp(8))
story.append(h2('3.5 Deduplication Logic'))
story.append(p(
    'Runs every 6 hours. Identifies near-duplicate deal pairs where acquirer and target names '
    'match (case-insensitive) and the deals were created within 6 hours of each other, '
    'excluding "Undisclosed" entities. Caps at 500 pairs per cycle. The PIE monitor checks '
    'dedup health as one of its 13 health checks.', 'body_j'))

story.append(sp(8))
story.append(h2('3.6 Known Issues — mawire-platform'))
story.append(table(
    [['Issue', 'Severity', 'Detail'],
     ['acquirer column missing',    'Low',    'PIE check_name_quality references deals.acquirer which may not exist — check skips with score=50'],
     ['confidence column missing',  'Low',    'PIE check_confidence_distribution references deals.confidence — check skips with score=50'],
     ['No ingestor retry logic',    'Medium', 'Individual ingestor failures only caught with try/catch — no retry or backoff on transient errors'],
     ['Extraction capped at 10k chars', 'Low', 'Large filings truncated at 10,000 chars — may miss deal value buried deep in document'],
     ['stats_cache proxy fallback', 'Low',    'export_freshness check falls back to deals.updated_at when stats_cache has no entry — less accurate'],
    ],
    [5.5*cm, 2*cm, 9.5*cm]
))

story.append(PageBreak())

# ── 4. MAWIRE-SITE ───────────────────────────────────────────────────────────
story.append(h1('4. mawire-site — Frontend (mergers.news)'))
story.append(hr(BLUE, 1))
story.append(p(
    'Static site hosted on Vercel. No server-side rendering — all data fetched client-side '
    'from GitHub raw CDN (deals.json) or same-origin files (pie-health.json). '
    'Vercel handles routing via vercel.json with cleanUrls enabled.', 'body_j'))

story.append(sp(8))
story.append(h2('4.1 Pages & Routes'))
story.append(table(
    [['URL', 'Source File', 'Description'],
     ['/',                         'index.html',                          'Main deal listings — loads deals.json from CDN'],
     ['/ipo',                      'ipo.html + ipo.js',                   'IPO tracker with dynamic loader'],
     ['/about',                    'about.html',                          'About page'],
     ['/contact',                  'contact.html',                        'Contact form (Formspree integration)'],
     ['/tender-offers',            'tender-offers.html',                  'Tender offer listings'],
     ['/mergers/technology',       'mergers/technology.html',             'Technology sector deal listings'],
     ['/mergers/healthcare',       'mergers/healthcare.html',             'Healthcare sector deal listings'],
     ['/mergers/financial-services','mergers/financial-services.html',   'Financial services deal listings'],
     ['/monitoring',               'monitoring.html',                     'PIE dashboard — SHA-256 password-gated'],
     ['/404',                      '404.html',                            'Custom 404 error page'],
     ['/pie-health.json',          'pie-health.json',                     'Live health snapshot — no-cache headers'],
     ['/sw.js',                    'sw.js',                               'Service worker — no-cache headers'],
    ],
    [5*cm, 5.5*cm, 6.5*cm]
))

story.append(sp(8))
story.append(h2('4.2 Vercel Configuration (vercel.json)'))
story.append(table(
    [['Setting', 'Value', 'Effect'],
     ['cleanUrls',      'true',  'Strips .html extension — /about instead of /about.html'],
     ['trailingSlash',  'false', 'Redirects /about/ → /about'],
     ['Rewrites',       '12 rules', '/monitoring→monitoring.html, /deal/(.*)→index.html, /ipo→ipo.html, sector pages, legal pages'],
    ],
    [3.5*cm, 3*cm, 10.5*cm]
))

story.append(sp(8))
story.append(h2('4.3 Security Headers'))
story.append(table(
    [['Header', 'Value'],
     ['Content-Security-Policy',    "default-src 'none'; script-src 'self' 'unsafe-inline' GTM; style-src 'self' 'unsafe-inline' Google Fonts; connect-src 'self' raw.githubusercontent.com formspree.io Google Analytics; worker-src 'self'"],
     ['Strict-Transport-Security',  'max-age=31536000; includeSubDomains; preload'],
     ['X-Frame-Options',            'DENY'],
     ['X-Content-Type-Options',     'nosniff'],
     ['Referrer-Policy',            'strict-origin-when-cross-origin'],
     ['Cross-Origin-Opener-Policy', 'same-origin'],
     ['Cross-Origin-Resource-Policy','same-origin'],
     ['Permissions-Policy',         'camera=(), geolocation=(), microphone=(), payment=(), usb=()'],
     ['Server',                     '(empty — removes server fingerprint)'],
    ],
    [5.5*cm, 11.5*cm]
))

story.append(sp(8))
story.append(h2('4.4 Service Worker (sw.js)'))
story.append(p(
    'Cache name: mergers-news-v6. Uses a shell-first caching strategy with stale-while-revalidate '
    'for static assets. Navigation requests are always network-first with cache fallback. '
    'raw.githubusercontent.com requests are network-only with empty array [] fallback to prevent '
    'stale CDN 404s from breaking the deals feed. pie-health.json fetches use cache-busting '
    '(?_=Date.now()) to always get fresh health data.', 'body_j'))
story.append(sp(4))
story.append(p('Shell URLs pre-cached on install:'))
story.append(b('/ — index'))
story.append(b('/style.css, /app.js, /charts.js, /manifest.json'))
story.append(b('/about, /about.js, /ipo, /ipo.js, /contact'))

story.append(sp(8))
story.append(h2('4.5 Monitoring Dashboard (/monitoring)'))
story.append(p(
    'Password-gated via SHA-256 hash in the browser. Session stored in sessionStorage. '
    'On unlock, fetches /pie-health.json (same-origin, no CDN caching issues). '
    'Displays overall score, category breakdown, per-check status, and active alerts. '
    'Password hash: 18af8f28a0a1e4af4f6896e44765996e1afc543614896e4dfa364ef8981c68e0', 'body_j'))

story.append(sp(8))
story.append(h2('4.6 Known Issues — mawire-site'))
story.append(table(
    [['Issue', 'Severity', 'Detail'],
     ['unsafe-inline in CSP',         'Medium', "script-src and style-src both allow 'unsafe-inline' — reduces XSS protection. Required by current inline scripts/styles."],
     ['Service worker v6 cache name', 'Low',    'If cache version not bumped on deploy, users may see stale assets until SW update cycle completes'],
     ['No offline fallback for deals','Low',    'If deals.json fetch fails and no cache exists, page shows empty state with no user message'],
     ['Legal pages referenced in vercel.json but may not exist', 'Medium', '/legal/terms, /legal/privacy, /legal/disclaimer rewrites defined but HTML files not confirmed deployed'],
    ],
    [5.5*cm, 2*cm, 9.5*cm]
))

story.append(PageBreak())

# ── 5. MAWIRE-MONITOR ────────────────────────────────────────────────────────
story.append(h1('5. mawire-monitor — Platform Integrity Engine'))
story.append(hr(BLUE, 1))
story.append(p(
    'Completely independent auditing system. Runs hourly at :45 via GitHub Actions. '
    'Connects directly to the PostgreSQL database, runs 13 health checks, persists results, '
    'manages alerts, triggers auto-remediation, and exports pie-health.json. '
    'No dependency on mawire-db or mawire-platform — audits those systems from the outside.', 'body_j'))

story.append(sp(8))
story.append(h2('5.1 Health Checks — 13 Checks Across 4 Categories'))
story.append(table(
    [['Check Name', 'Category', 'Weight', 'What It Measures', 'Fail Threshold'],
     ['ingestion_freshness',      'ingestion', '35%', 'Age of most recent deal in DB',                    '> 8 hours since last deal'],
     ['ingestion_velocity',       'ingestion', '35%', 'Deal count in rolling 24h/7d/30d windows',         '0 deals in last 24 hours'],
     ['source_diversity',         'ingestion', '35%', 'Number of active source types in last 48h',        '0 active sources'],
     ['filing_coverage',          'ingestion', '35%', 'Presence of all 4 key SEC filing types in 7d',    '3+ filing types missing'],
     ['name_quality',             'quality',   '30%', 'Placeholder names (Undisclosed etc.) in active deals','> 30% with placeholder names'],
     ['value_completeness',       'quality',   '30%', 'Active deals missing deal_value',                  '> 80% missing value'],
     ['data_completeness',        'quality',   '30%', 'Avg fill rate: sector, region, country, headline', '< 60% average fill'],
     ['dedup_health',             'pipeline',  '20%', 'Near-duplicate deal pairs in DB',                  '> 50 duplicate pairs'],
     ['export_freshness',         'pipeline',  '20%', 'Age of last deals.json export',                    '> 14 hours since export'],
     ['review_queue',             'pipeline',  '20%', 'Deals pending human/AI review',                    '> 200 deals in queue'],
     ['geographic_coverage',      'coverage',  '15%', 'Distinct regions + deals with region set',         'N/A (warn only)'],
     ['sector_coverage',          'coverage',  '15%', 'Distinct sectors in active deals',                 'N/A (warn only)'],
     ['confidence_distribution',  'coverage',  '15%', 'Avg confidence score + low-confidence ratio',      '> 45% below 0.70'],
    ],
    [4.2*cm, 2.3*cm, 1.5*cm, 5*cm, 4*cm]
))

story.append(sp(8))
story.append(h2('5.2 Scoring Engine'))
story.append(p('Each check returns a score 0–100. Category score = average of non-skipped checks in that category. '
               'Overall score = weighted average of category scores.'))
story.append(table(
    [['Score Range', 'Status', 'Meaning'],
     ['≥ 85', 'healthy',  'All systems operating normally'],
     ['60–84', 'degraded', 'One or more checks in warning state — investigate'],
     ['< 60',  'critical', 'One or more checks failing — immediate action required'],
    ],
    [3*cm, 3*cm, 11*cm]
))

story.append(sp(8))
story.append(h2('5.3 Alert Management'))
story.append(p(
    'Alerts are upserted to pie_alerts table. A failing check creates/updates a critical alert. '
    'A warning check creates/updates a warning alert. A passing check resolves any existing alert. '
    'Auto-remediation: name_quality failures queue placeholder-name deals for re-enrichment '
    '(sets needs_review=true). Dedup alerts are logged but deduplication is handled by the platform scheduler.', 'body_j'))

story.append(sp(8))
story.append(h2('5.4 Export'))
story.append(p('On each run, exports pie-health.json to two repos:'))
story.append(b('realfrantheman/mawire-monitor — source of truth, permanent record'))
story.append(b('realfrantheman/mawire-site — same-origin serving at mergers.news/pie-health.json'))
story.append(sp(4))
story.append(p('pie-health.json contains: generatedAt, overallScore, status, durationMs, '
               'categories (with per-category scores and check details), full checks array, '
               'active alerts array, and summary counts (pass/warn/fail/skip/critical/warnings).'))

story.append(sp(8))
story.append(h2('5.5 GitHub Actions Workflow'))
story.append(table(
    [['Setting', 'Value'],
     ['Schedule',     'cron: 45 * * * * (every hour at :45)'],
     ['Trigger',      'schedule + workflow_dispatch'],
     ['Runner',       'ubuntu-latest'],
     ['Timeout',      '10 minutes'],
     ['Permissions',  'contents: write'],
     ['Node version', '20'],
     ['Install',      'npm install (no lockfile — installs pg)'],
     ['Run',          'node index.js'],
    ],
    [4*cm, 13*cm]
))

story.append(sp(8))
story.append(h2('5.6 Secrets Required'))
story.append(table(
    [['Secret', 'Purpose'],
     ['DATABASE_URL', 'PostgreSQL connection for all 13 health checks and persisting results'],
     ['MAWIRE_TOKEN', 'GitHub PAT for exporting pie-health.json to mawire-monitor and mawire-site'],
    ],
    [4*cm, 13*cm]
))

story.append(sp(8))
story.append(h2('5.7 Known Issues — mawire-monitor'))
story.append(table(
    [['Issue', 'Severity', 'Detail'],
     ['No package-lock.json', 'Low', 'npm install resolves latest pg on every run — could break if pg releases breaking change. Fix: generate and commit package-lock.json.'],
     ['Node.js 20 deprecation', 'Low', 'actions/checkout@v4 and actions/setup-node@v4 will be forced to Node.js 24 after June 16 2026. Update FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true or upgrade actions.'],
     ['acquirer/confidence columns', 'Low', 'name_quality and confidence_distribution checks reference columns that may not exist in the deals table — silently skips with score=50.'],
     ['No alerting output channel', 'Medium', 'Alerts are stored in DB and visible on dashboard only — no email/Slack/webhook notification on critical alerts.'],
    ],
    [5*cm, 2*cm, 10*cm]
))

story.append(PageBreak())

# ── 6. RECENT INCIDENTS ──────────────────────────────────────────────────────
story.append(h1('6. Recent Incidents & Fixes'))
story.append(hr(BLUE, 1))

story.append(table(
    [['Date (UTC)', 'Incident', 'Root Cause', 'Fix Applied'],
     ['2026-06-10', '/monitoring showing HTTP 404 for health data',
      'HEALTH_URL pointed to raw.githubusercontent.com — GitHub CDN was caching the 404 response from before pie-health.json existed',
      'Changed HEALTH_URL to same-origin /pie-health.json. Added pie-health.json to mawire-site deploy. PIE now exports to mawire-site directly.'],
     ['2026-06-10', 'Dashboard showed error even after fix',
      'Duplicate loadHealth() call — one from unlock() and one unconditional call at end of script. Race condition caused error state to override success.',
      'Removed unconditional loadHealth() call. Only called from unlock() now.'],
     ['2026-06-10', 'Transient 404 window after deploy',
      'deploy.py deployed monitoring.html BEFORE pie-health.json — Vercel could serve the new page before the JSON existed',
      'Reordered MAPPINGS in deploy.py: pie-health.json now deploys before monitoring.html.'],
     ['2026-06-10', 'Auto-backfill merge conflict on deals.json',
      'git pull --rebase failed: refresh-deals workflow pushed a new deals.json to main during the 25-minute backfill window. Git could not auto-resolve the JSON conflict.',
      'Replaced pull --rebase with fetch+reset+reapply: save export, reset to origin/main, re-apply export, push. DB is always authoritative.'],
    ],
    [2.5*cm, 4*cm, 5*cm, 5.5*cm]
))

story.append(PageBreak())

# ── 7. CODEX INTEGRATION ─────────────────────────────────────────────────────
story.append(h1('7. Codex Integration — External Audit System'))
story.append(hr(BLUE, 1))
story.append(p(
    'mawire-monitor is configured as a Codex-controlled external auditing system. '
    'It is fully independent from the rest of the platform and includes an AGENTS.md '
    'file with complete instructions for OpenAI Codex CLI.', 'body_j'))

story.append(sp(8))
story.append(h2('7.1 Repository Setup'))
story.append(table(
    [['File', 'Purpose'],
     ['index.js',                        '13 PIE health checks + scoring + alert management + DB persistence + export'],
     ['package.json',                    'Single dependency: pg ^8.11.0. Scripts: npm start → node index.js'],
     ['AGENTS.md',                       'Full Codex CLI instructions: how to run, add checks, modify thresholds, SQL debugging queries'],
     ['.github/workflows/run.yml',       'GitHub Actions: hourly schedule at :45 + workflow_dispatch for manual trigger'],
    ],
    [5.5*cm, 11.5*cm]
))

story.append(sp(8))
story.append(h2('7.2 Codex Access Model'))
story.append(table(
    [['Repository', 'Read', 'Write', 'Actions Trigger'],
     ['mawire-db',       '✓', '✗', '✗'],
     ['mawire-platform', '✓', '✗', '✗'],
     ['mawire-site',     '✓', '✗', '✗'],
     ['mawire-monitor',  '✓', '✗', '✓ (workflow_dispatch only)'],
    ],
    [5*cm, 2.5*cm, 2.5*cm, 7*cm]
))
story.append(sp(4))
story.append(p('Implemented via a fine-grained GitHub PAT (CODEX_AUDIT_TOKEN) with Contents: Read on all repos '
               'and Actions: Read+Write on mawire-monitor only.'))

story.append(sp(8))
story.append(h2('7.3 Audit Capabilities'))
story.append(b('Full code scan across all four repositories — bugs, security issues, dead code'))
story.append(b('Live website scan at mergers.news — all URLs, HTTP status, asset loading, JS errors'))
story.append(b('PIE monitor trigger — run workflow_dispatch and read resulting pie-health.json'))
story.append(b('Database query access — cross-reference alerts with live DB state'))
story.append(b('Structured markdown audit report with severity classification'))

story.append(sp(8))
story.append(h2('7.4 Required Secrets in mawire-monitor'))
story.append(table(
    [['Secret', 'Value Source', 'Used For'],
     ['DATABASE_URL',       'Neon dashboard',           'PIE health checks + DB access'],
     ['MAWIRE_TOKEN',       'GitHub PAT (repo+workflow)','Export pie-health.json to mawire-monitor + mawire-site'],
     ['OPENAI_API_KEY',     'OpenAI dashboard',         'Codex CLI audit runs'],
     ['CODEX_AUDIT_TOKEN',  'GitHub fine-grained PAT',  'Read-only access to all repos during Codex audit'],
    ],
    [4*cm, 4.5*cm, 8.5*cm]
))

story.append(PageBreak())

# ── 8. ENVIRONMENT & DEPLOYMENT ──────────────────────────────────────────────
story.append(h1('8. Environment & Deployment Reference'))
story.append(hr(BLUE, 1))

story.append(h2('8.1 Infrastructure'))
story.append(table(
    [['Component', 'Provider', 'Notes'],
     ['Backend runtime',     'Railway',         'Node.js 18+, always-on, env vars: DATABASE_URL'],
     ['Database',            'Neon (serverless PostgreSQL)', 'SSL required (rejectUnauthorized: false), max 3 pool connections in PIE, connection timeout 10s'],
     ['Frontend hosting',    'Vercel',          'Static site, CDN, automatic HTTPS, custom domain mergers.news'],
     ['DNS / Domain',        'mergers.news',    'Points to Vercel CDN'],
     ['CI/CD',               'GitHub Actions',  'Runs on ubuntu-latest, Node.js 20 (deprecation warning: upgrade before Sep 16 2026)'],
     ['Code storage',        'GitHub',          'All four repos under realfrantheman/'],
     ['Contact forms',       'Formspree',       'CSP allows formspree.io in connect-src and form-action'],
     ['Analytics',           'Google Analytics / GTM', 'CSP allows googletagmanager.com, google-analytics.com, analytics.google.com'],
    ],
    [4*cm, 4.5*cm, 8.5*cm]
))

story.append(sp(8))
story.append(h2('8.2 Full Secrets Reference'))
story.append(table(
    [['Secret Name', 'Repos That Need It', 'Description'],
     ['MAWIRE_TOKEN',      'mawire-db, mawire-monitor', 'GitHub PAT. Needs repo scope (read/write all repos) + workflow scope (create/update .github/workflows/ files). Used by deploy.py, backfill push, and PIE export.'],
     ['DATABASE_URL',      'mawire-db, mawire-monitor', 'Neon PostgreSQL connection string. Format: postgresql://user:pass@host/dbname?sslmode=require'],
     ['OPENAI_API_KEY',    'mawire-monitor',            'OpenAI API key for Codex CLI audit runs (optional until Codex audit workflow is added)'],
     ['CODEX_AUDIT_TOKEN', 'mawire-monitor',            'Fine-grained GitHub PAT: Contents Read on all four repos, Actions Read+Write on mawire-monitor only'],
    ],
    [4*cm, 4.5*cm, 8.5*cm]
))

story.append(sp(8))
story.append(h2('8.3 Deployment Checklist'))
story.append(b('mawire-db: push to main or claude/** branch → deploy.yml triggers automatically'))
story.append(b('mawire-platform: deploy.yml copies scheduler.js and all service/script files — Railway auto-redeploys on repo push'))
story.append(b('mawire-site: deploy.yml copies all DEPLOY-* and FIX-sw.js, app.js, style.css, vercel.json — Vercel auto-deploys on repo push'))
story.append(b('mawire-monitor: self-managed — edit files directly in mawire-monitor repo, GitHub Actions handles the rest'))
story.append(b('New secrets: must be added to BOTH mawire-db (for deploy.py) AND target repos independently'))
story.append(b('Workflow scope: MAWIRE_TOKEN must have workflow scope to create/modify .github/workflows/ files via API'))

story.append(PageBreak())

# ── 9. SUMMARY TABLE ─────────────────────────────────────────────────────────
story.append(h1('9. Platform Health Summary'))
story.append(hr(BLUE, 1))
story.append(table(
    [['Area', 'Status', 'Notes'],
     ['SEC EDGAR ingestion',         '✓ Active',  'Every 30 min, DEFM14A/SC TO-T/S-4/SC 13E-3/DEFA14A/PREM14A'],
     ['GDELT ingestion',             '✓ Active',  'Every 1 hour'],
     ['News RSS ingestion',          '✓ Active',  'Every 2 hours'],
     ['EU Merger Registry',          '✓ Active',  'Every 12 hours'],
     ['APAC (HKEX/ASX/SGX)',         '✓ Active',  'Every 4 hours'],
     ['Historical backfill',         '⚠ Fixed',   'Merge conflict bug fixed — fetch+reset strategy now used'],
     ['AI extraction queue',         '✓ Active',  'Every 5 min, cap 20 deals/cycle'],
     ['Deduplication',               '✓ Active',  'Every 6 hours'],
     ['GitHub export (deals.json)',   '✓ Active',  'Every 2 hours + on backfill completion'],
     ['Frontend (mergers.news)',      '✓ Live',    'Vercel CDN, full security headers, service worker v6'],
     ['Monitoring dashboard',         '✓ Live',    '/monitoring — SHA-256 password gate, same-origin health fetch'],
     ['PIE health monitor',           '✓ Active',  'Every hour at :45, 13 checks, last run: SUCCESS'],
     ['Codex audit integration',      '⚠ Partial', 'AGENTS.md and fine-grained PAT setup required — OPENAI_API_KEY not yet added'],
     ['auto-backfill.yml',            '✓ Fixed',   'Merge conflict in deals.json resolved'],
    ],
    [5.5*cm, 2.5*cm, 9*cm]
))

story.append(sp(12))
story.append(hr(NAVY, 1.5))
story.append(sp(6))
story.append(p('mergers.news Platform Summary — Confidential', 'small'))
story.append(p(f'Generated {datetime.utcnow().strftime("%B %d, %Y at %H:%M UTC")} · realfrantheman/mawire-db', 'small'))

# ── BUILD ─────────────────────────────────────────────────────────────────────
doc.build(story)
print(f'PDF written to {OUT}')
