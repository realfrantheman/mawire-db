#!/usr/bin/env python3
"""Atomic deployment controller for mergers.news."""
import base64, json, os, sys, urllib.request, urllib.error
TOKEN=os.environ.get('GITHUB_TOKEN') or os.environ.get('MAWIRE_TOKEN')
if not TOKEN: raise SystemExit('GITHUB_TOKEN/MAWIRE_TOKEN is required')
OWNER='realfrantheman'
MAPPINGS=[
('FIX-scheduler-v2.js','mawire-platform','scheduler.js'),('FIX-sec-ingestor-index.js','mawire-platform','services/sec-ingestor/index.js'),('FIX-historical-backfill.js','mawire-platform','scripts/historical-backfill.js'),('FIX-export-to-github.js','mawire-platform','scripts/export-to-github.js'),('FIX-eu-ingestor.js','mawire-platform','services/eu-ingestor/index.js'),('FIX-apac-ingestor.js','mawire-platform','services/apac-ingestor/index.js'),('FIX-news-ingestor.js','mawire-platform','services/news-ingestor/index.js'),('FIX-gdelt-ingestor.js','mawire-platform','services/gdelt-ingestor/index.js'),('FIX-deal-extraction.js','mawire-platform','services/shared/deal-extraction.js'),('FIX-source-url.js','mawire-platform','services/shared/source-url.js'),('FIX-source-url-backfill.js','mawire-platform','scripts/source-url-backfill.js'),('FIX-api-service.js','mawire-platform','services/api/index.js'),('FIX-platform-schema.sql','mawire-platform','schema.sql'),('FIX-platform-schema.sql','mawire-platform','database/schema.sql'),('FIX-ingestion-quality-migration.sql','mawire-platform','database/migrations/20260611_ingestion_quality.sql'),('FIX-enrich-deals.js','mawire-platform','scripts/enrich-deals.js'),
('DEPLOY-index.html','mawire-site','index.html'),('DEPLOY-ipo.html','mawire-site','ipo.html'),('DEPLOY-about.html','mawire-site','about.html'),('DEPLOY-contact.html','mawire-site','contact.html'),('DEPLOY-tender-offers.html','mawire-site','tender-offers.html'),('DEPLOY-mergers-technology.html','mawire-site','mergers/technology.html'),('DEPLOY-mergers-healthcare.html','mawire-site','mergers/healthcare.html'),('DEPLOY-mergers-financial-services.html','mawire-site','mergers/financial-services.html'),('DEPLOY-404.html','mawire-site','404.html'),('DEPLOY-legal-terms.html','mawire-site','legal/terms.html'),('DEPLOY-legal-privacy.html','mawire-site','legal/privacy.html'),('DEPLOY-legal-disclaimer.html','mawire-site','legal/disclaimer.html'),('DEPLOY-monitoring.html','mawire-site','monitoring.html'),('DEPLOY-manifest.json','mawire-site','manifest.json'),('DEPLOY-feed.xml','mawire-site','feed.xml'),('DEPLOY-rss.xml','mawire-site','rss.xml'),('icon-192.png','mawire-site','icon-192.png'),('icon-512.png','mawire-site','icon-512.png'),('FIX-sw.js','mawire-site','sw.js'),('DEPLOY-cache-control.js','mawire-site','cache-control.js'),('DEPLOY-sector-deals.js','mawire-site','sector-deals.js'),('DEPLOY-source-taxonomy.js','mawire-site','source-taxonomy.js'),('FIX-ipo-dynamic-loader.js','mawire-site','ipo.js'),('FIX-quality-hardening.js','mawire-site','quality-hardening.js'),('app.js','mawire-site','app.js'),('style.css','mawire-site','style.css'),('DEPLOY-vercel.json','mawire-site','vercel.json')]

def api(path,method='GET',body=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request('https://api.github.com'+path,data=data,method=method,headers={'Authorization':f'Bearer {TOKEN}','Accept':'application/vnd.github+json','Content-Type':'application/json','User-Agent':'mawire-deploy/2.0','X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.urlopen(req) as r:
            raw=r.read(); return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e: raise RuntimeError(f'{method} {path} -> {e.code}: {e.read().decode()[:300]}')

def prepare(repo,items):
    ref=api(f'/repos/{OWNER}/{repo}/git/ref/heads/main'); base=ref['object']['sha']; commit=api(f'/repos/{OWNER}/{repo}/git/commits/{base}'); base_tree=commit['tree']['sha']; entries=[]
    for src,dest in items:
        if not os.path.exists(src): raise RuntimeError(f'missing deployment source {src}')
        raw=open(src,'rb').read(); blob=api(f'/repos/{OWNER}/{repo}/git/blobs','POST',{'content':base64.b64encode(raw).decode(),'encoding':'base64'}); entries.append({'path':dest,'mode':'100644','type':'blob','sha':blob['sha']})
    tree=api(f'/repos/{OWNER}/{repo}/git/trees','POST',{'base_tree':base_tree,'tree':entries}); new=api(f'/repos/{OWNER}/{repo}/git/commits','POST',{'message':'deploy: atomic quality hardening release','tree':tree['sha'],'parents':[base]})['sha']; return {'repo':repo,'base':base,'new':new,'count':len(entries)}

def update(plan,sha,force=False): api(f"/repos/{OWNER}/{plan['repo']}/git/refs/heads/main",'PATCH',{'sha':sha,'force':force})

def main():
    grouped={}
    for src,repo,dest in MAPPINGS: grouped.setdefault(repo,[]).append((src,dest))
    plans=[prepare(repo,items) for repo,items in grouped.items()]
    updated=[]
    try:
        for p in plans: update(p,p['new']); updated.append(p); print(f"OK {p['repo']} {p['count']} files -> {p['new'][:10]}")
    except Exception:
        for p in reversed(updated):
            try: update(p,p['base'],True); print(f"ROLLBACK {p['repo']} -> {p['base'][:10]}")
            except Exception as e: print(f"ROLLBACK FAILED {p['repo']}: {e}",file=sys.stderr)
        raise
if __name__=='__main__': main()
