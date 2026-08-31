'use strict';

const { Pool } = require('pg');
const DB_URL = process.env.DATABASE_URL;
const GH_TOKEN = process.env.MAWIRE_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'realfrantheman';
const REPO = 'mawire-db';
const db = new Pool({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  max: 3,
});

async function q(sql, params) { return db.query(sql, params || []); }
function result(name, category, status, score, message, detail) { return { name, category, status, score, message, detail: detail || {} }; }
const ACTIVE = "COALESCE(d.status,'') NOT IN ('Completed','Terminated','Withdrawn')";

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS pie_checks (id SERIAL PRIMARY KEY, check_name VARCHAR(80) NOT NULL, category VARCHAR(40) NOT NULL, status VARCHAR(10) NOT NULL, score NUMERIC(5,2), message TEXT, detail JSONB, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS pie_alerts (id SERIAL PRIMARY KEY, alert_key VARCHAR(150) NOT NULL UNIQUE, severity VARCHAR(20) NOT NULL, title TEXT NOT NULL, description TEXT, check_name VARCHAR(80), first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, auto_remedied BOOLEAN DEFAULT FALSE);
    CREATE TABLE IF NOT EXISTS pie_health_snapshots (id SERIAL PRIMARY KEY, overall_score NUMERIC(5,2), pass_count INT DEFAULT 0, warn_count INT DEFAULT 0, fail_count INT DEFAULT 0, active_alerts INT DEFAULT 0, snapshot JSONB, taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
}

async function checks() {
  return [
    ['ingestion_freshness','ingestion',async function () { const r=(await q(`SELECT MAX(created_at) t, EXTRACT(EPOCH FROM(NOW()-MAX(created_at)))/3600 h FROM deals`)).rows[0]; if(!r.t)return result('ingestion_freshness','ingestion','fail',0,'No deals in database'); const h=Number(r.h); return result('ingestion_freshness','ingestion',h>8?'fail':h>4?'warn':'pass',h>8?10:h>4?60:100,`Last deal ingested ${h.toFixed(1)}h ago`,{ageHours:h}); }],
    ['ingestion_velocity','ingestion',async function () { const r=(await q(`SELECT COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '24 hours') n24, COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '7 days') n7 FROM deals`)).rows[0]; const n=Number(r.n24); return result('ingestion_velocity','ingestion',n===0?'fail':n<3?'warn':'pass',n===0?5:n<3?55:100,`${n} deals last 24h · ${Number(r.n7)} last 7d`); }],
    ['source_diversity','ingestion',async function () { const rows=(await q(`SELECT ds.source_type,COUNT(*) cnt FROM deal_sources ds JOIN deals d ON d.id=ds.deal_id WHERE d.created_at>NOW()-INTERVAL '48 hours' GROUP BY ds.source_type`)).rows; return result('source_diversity','ingestion',rows.length===0?'fail':rows.length<2?'warn':'pass',rows.length===0?0:rows.length<2?55:100,`${rows.length} source type(s) active in last 48h`,{sources:rows}); }],
    ['filing_coverage','ingestion',async function () { const rows=(await q(`SELECT filing_type FROM filings WHERE created_at>NOW()-INTERVAL '7 days' GROUP BY filing_type`)).rows.map(x=>x.filing_type); const expected=['DEFM14A','SC TO-T','S-4','DEFA14A']; const missing=expected.filter(x=>!rows.includes(x)); return result('filing_coverage','ingestion',missing.length>=3?'fail':missing.length?'warn':'pass',missing.length>=3?20:missing.length?70:100,missing.length?`Missing in last 7d: ${missing.join(', ')}`:'All key filing types seen in last 7d',{missing}); }],
    ['name_quality','quality',async function () { const r=(await q(`SELECT COUNT(*) total, COUNT(*) FILTER(WHERE COALESCE(a.name,d.extracted_acquirer_name,'') ~* '^(unknown|undisclosed|acquirer \\(see filing\\)|disclosed in filing|n/a)$' OR COALESCE(t.name,d.extracted_target_name,'') ~* '^(unknown|undisclosed|target \\(see filing\\)|disclosed in filing|n/a)$') bad FROM deals d LEFT JOIN companies a ON a.id=d.acquirer_id LEFT JOIN companies t ON t.id=d.target_id WHERE ${ACTIVE}`)).rows[0]; const total=Number(r.total),bad=Number(r.bad),ratio=total?bad/total:0; return result('name_quality','quality',ratio>.30?'fail':ratio>.15?'warn':'pass',ratio>.30?20:ratio>.15?60:100,`${bad}/${total} active deals (${(ratio*100).toFixed(1)}%) have placeholder parties`,{ratio}); }],
    ['source_url_quality','quality',async function () { const r=(await q(`SELECT COUNT(*) total, COUNT(*) FILTER(WHERE COALESCE(NULLIF(f.document_url,''),NULLIF(ds.source_url,'')) IS NULL) missing, COUNT(*) FILTER(WHERE COALESCE(f.document_url,ds.source_url,'') ~* '(browse-edgar|search-index|-index\\.html$|/data/[0-9]{12,}/)') indirect FROM deals d LEFT JOIN LATERAL(SELECT document_url FROM filings f WHERE f.deal_id=d.id ORDER BY f.created_at LIMIT 1) f ON true LEFT JOIN LATERAL(SELECT source_url FROM deal_sources ds WHERE ds.deal_id=d.id ORDER BY ds.created_at LIMIT 1) ds ON true`)).rows[0]; const total=Number(r.total),missing=Number(r.missing),indirect=Number(r.indirect),ratio=total?(missing+indirect)/total:1; return result('source_url_quality','quality',ratio>.25?'fail':ratio>.05?'warn':'pass',ratio>.25?25:ratio>.05?65:100,`${missing} missing source URLs · ${indirect} indirect/malformed URLs`,{missing,indirect,ratio}); }],
    ['dedup_health','pipeline',async function () { const r=(await q(`SELECT COUNT(*) dup_pairs FROM (SELECT a.id FROM deals a JOIN deals b ON b.id>a.id AND a.acquirer_id IS NOT DISTINCT FROM b.acquirer_id AND a.target_id IS NOT DISTINCT FROM b.target_id AND a.announcement_date IS NOT DISTINCT FROM b.announcement_date WHERE (a.acquirer_id IS NOT NULL OR a.target_id IS NOT NULL) LIMIT 500) x`)).rows[0]; const n=Number(r.dup_pairs); return result('dedup_health','pipeline',n>50?'fail':n>15?'warn':'pass',n>50?20:n>15?60:100,`${n} potential duplicate pairs detected`); }],
    ['confidence_distribution','coverage',async function () { const r=(await q(`SELECT COUNT(*) total, COUNT(*) FILTER(WHERE source_confidence<0.70) low, ROUND(AVG(source_confidence)::numeric,3) avg FROM deals d WHERE ${ACTIVE} AND source_confidence IS NOT NULL`)).rows[0]; const total=Number(r.total),low=Number(r.low),ratio=total?low/total:0,avg=Number(r.avg||0); return result('confidence_distribution','coverage',ratio>.45?'fail':ratio>.25?'warn':'pass',ratio>.45?30:ratio>.25?65:100,`Avg confidence ${avg} · ${low}/${total} below 0.70`,{ratio,avg}); }],
    ['export_freshness','pipeline',async function () { const r=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=deals-index.json&per_page=1`,{headers:{Authorization:`Bearer ${GH_TOKEN}`,Accept:'application/vnd.github+json'}}); if(!r.ok)throw new Error(`GitHub ${r.status}`); const rows=await r.json(); if(!rows.length)return result('export_freshness','pipeline','fail',0,'deals-index.json has no commit history'); const ts=rows[0].commit.committer.date; const h=(Date.now()-new Date(ts).getTime())/3600000; return result('export_freshness','pipeline',h>14?'fail':h>5?'warn':'pass',h>14?10:h>5?60:100,`Public deal index updated ${h.toFixed(1)}h ago`,{ageHours:h}); }]
  ];
}

async function persist(items, score) {
  for (const c of items) await q(`INSERT INTO pie_checks(check_name,category,status,score,message,detail) VALUES($1,$2,$3,$4,$5,$6)`,[c.name,c.category,c.status,c.score,c.message,JSON.stringify(c.detail)]);
  const active = items.filter(c=>c.status==='warn'||c.status==='fail');
  for (const c of active) await q(`INSERT INTO pie_alerts(alert_key,severity,title,description,check_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,description=EXCLUDED.description,last_seen=NOW(),resolved_at=NULL`,[`check:${c.name}`,c.status==='fail'?'critical':'warning',c.name.replace(/_/g,' '),c.message,c.name]);
  const keys=active.map(c=>`check:${c.name}`); if(keys.length) await q(`UPDATE pie_alerts SET resolved_at=NOW() WHERE resolved_at IS NULL AND NOT(alert_key=ANY($1))`,[keys]); else await q(`UPDATE pie_alerts SET resolved_at=NOW() WHERE resolved_at IS NULL`);
  const counts=items.reduce((a,c)=>(a[c.status]=(a[c.status]||0)+1,a),{});
  await q(`INSERT INTO pie_health_snapshots(overall_score,pass_count,warn_count,fail_count,active_alerts,snapshot) VALUES($1,$2,$3,$4,$5,$6)`,[score,counts.pass||0,counts.warn||0,counts.fail||0,active.length,JSON.stringify({checks:items})]);
  return active;
}

async function publish(payload) {
  if(!GH_TOKEN)return;
  const api=`https://api.github.com/repos/${OWNER}/${REPO}/contents/pie-health.json`;
  const headers={Authorization:`Bearer ${GH_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'};
  const current=await fetch(api,{headers}); let sha=null; if(current.ok)sha=(await current.json()).sha;
  const body={message:`pie: health snapshot ${payload.generatedAt.slice(0,16)}Z`,content:Buffer.from(JSON.stringify(payload,null,2)+'\n').toString('base64')}; if(sha)body.sha=sha;
  const r=await fetch(api,{method:'PUT',headers,body:JSON.stringify(body)}); if(!r.ok)throw new Error(`Health publish failed ${r.status}: ${await r.text()}`);
}

async function run() {
  await ensureSchema();
  const defs=await checks(); const out=[];
  for(const [name,category,fn] of defs){try{out.push(await fn());}catch(e){out.push(result(name,category,'fail',0,`Check error: ${e.message}`,{error:true}));}}
  const score=Math.round(out.reduce((s,c)=>s+c.score,0)/out.length);
  const status=score>=85?'healthy':score>=70?'degraded':'critical';
  const alerts=await persist(out,score);
  const payload={generatedAt:new Date().toISOString(),overallScore:score,status,checks:out.map(({name,category,status,score,message})=>({name,category,status,score,message})),alerts:alerts.map(c=>({key:`check:${c.name}`,severity:c.status==='fail'?'critical':'warning',title:c.name.replace(/_/g,' '),description:c.message}))};
  await publish(payload);
  console.log(`[PIE] ${score}/100 ${status} · ${out.filter(c=>c.status==='fail').length} failed checks`);
  await db.end();
  if(status==='critical'||out.some(c=>c.status==='fail')) throw new Error('PIE health gate failed');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exit(1)});
module.exports={run};
