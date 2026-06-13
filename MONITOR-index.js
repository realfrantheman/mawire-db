'use strict';
// Entry point — runs Plane A (database integrity) + Plane B (product integrity)
// Combines results into a dual-plane health JSON and exports to GitHub

const https = require('https');
const fs    = require('fs');

const pie       = require('./pie');
const synthetic = require('./synthetic');

const GH_TOKEN  = process.env.MAWIRE_TOKEN || process.env.GITHUB_TOKEN;
const GH_OWNER  = 'realfrantheman';
const GH_REPOS  = ['mawire-monitor', 'mawire-site'];  // write pie-health.json to both
const HEALTH_FILE = 'pie-health.json';

// ── GITHUB HELPERS ────────────────────────────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'mawire-monitor/2.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function exportHealthJson(payload) {
  if (!GH_TOKEN) { console.log('[MONITOR] No token — skipping export'); return; }
  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const message = `monitor: health snapshot ${new Date().toISOString().slice(0, 16)}Z`;

  for (const repo of GH_REPOS) {
    try {
      const existing = await ghRequest('GET', `/repos/${GH_OWNER}/${repo}/contents/${HEALTH_FILE}`);
      const sha = existing?.body?.sha;
      await ghRequest('PUT', `/repos/${GH_OWNER}/${repo}/contents/${HEALTH_FILE}`, {
        message, content, ...(sha ? { sha } : {}),
      });
      console.log(`[MONITOR] Exported ${HEALTH_FILE} → ${repo}`);
    } catch (err) {
      console.error(`[MONITOR] Export to ${repo} failed:`, err.message);
    }
  }
}

// Open a GitHub Issue when status transitions to critical, close on recovery
async function manageAlert(overall, prevOverall) {
  if (!GH_TOKEN) return;
  const isCritical = overall === 'critical';
  const wasCritical = prevOverall === 'critical';

  try {
    // Find existing open alert issue
    const listRes = await ghRequest('GET',
      `/repos/${GH_OWNER}/mawire-monitor/issues?state=open&labels=pie-alert&per_page=5`);
    const issues = Array.isArray(listRes?.body) ? listRes.body : [];
    const openIssue = issues[0];

    if (isCritical && !wasCritical) {
      // New critical — open issue
      if (!openIssue) {
        await ghRequest('POST', `/repos/${GH_OWNER}/mawire-monitor/issues`, {
          title: `[CRITICAL] Platform health alert — ${new Date().toISOString().slice(0, 16)}Z`,
          body:  `Platform Integrity Engine detected a critical health degradation.\n\nCheck \`/monitoring\` on mergers.news for details.`,
          labels: ['pie-alert'],
        });
        console.log('[MONITOR] Opened critical alert issue');
      }
    } else if (!isCritical && wasCritical && openIssue) {
      // Recovered — close issue
      await ghRequest('PATCH', `/repos/${GH_OWNER}/mawire-monitor/issues/${openIssue.number}`, {
        state: 'closed',
        body:  (openIssue.body || '') + `\n\n✅ Resolved at ${new Date().toISOString()}`,
      });
      console.log('[MONITOR] Closed alert issue — platform recovered');
    }
  } catch (err) {
    console.error('[MONITOR] Alert management error (non-fatal):', err.message);
  }
}

// ── STATUS HELPERS ────────────────────────────────────────────────────────────
function statusLabel(score) {
  if (score >= 85) return 'healthy';
  if (score >= 60) return 'degraded';
  return 'critical';
}

function worstStatus(s1, s2) {
  const rank = { critical: 0, degraded: 1, healthy: 2 };
  return (rank[s1] ?? 2) <= (rank[s2] ?? 2) ? s1 : s2;
}

// ── PLANE RUNNER (with timeout) ───────────────────────────────────────────────
function withTimeout(promise, ms, name) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms)),
  ]);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log('[MONITOR] ══════════════════════════════════════════');
  console.log('[MONITOR] Platform Integrity Engine v2 starting');
  console.log('[MONITOR] ══════════════════════════════════════════');

  // Load previous health for transition detection
  let prevOverall = null;
  try {
    const prev = JSON.parse(fs.readFileSync('./' + HEALTH_FILE, 'utf8'));
    prevOverall = prev.overall;
  } catch (_) {}

  // Run both planes concurrently (each has its own internal timeout)
  const [planeAResult, planeBResult] = await Promise.allSettled([
    withTimeout(pie.run(),       240_000, 'Plane A (database)'),
    withTimeout(synthetic.run(), 120_000, 'Plane B (synthetic)'),
  ]);

  const planeA = planeAResult.status === 'fulfilled'
    ? planeAResult.value
    : { overallScore: 0, status: 'critical', checks: [], summary: { pass:0,warn:0,fail:0,error:1 },
        error: planeAResult.reason?.message };

  const planeB = planeBResult.status === 'fulfilled'
    ? planeBResult.value
    : { overallScore: 0, status: 'critical', checks: [], summary: { pass:0,warn:0,fail:0,error:1 },
        error: planeBResult.reason?.message };

  if (planeAResult.status === 'rejected') console.error('[MONITOR] Plane A failed:', planeAResult.reason?.message);
  if (planeBResult.status === 'rejected') console.error('[MONITOR] Plane B failed:', planeBResult.reason?.message);

  // overall = worst of the two planes — a green data plane cannot hide a red product plane
  const overallStatus = worstStatus(planeA.status, planeB.status);
  const overallScore  = Math.min(planeA.overallScore, planeB.overallScore);

  console.log(`[MONITOR] ── Final: ${overallScore}/100 (${overallStatus}) ──`);

  const payload = {
    generatedAt:   new Date().toISOString(),
    overall:       overallStatus,
    overallScore,
    durationMs:    Date.now() - t0,
    // Legacy field for backward compatibility with dashboard
    status:        overallStatus,

    dataIntegrity: {
      score:      planeA.overallScore,
      status:     planeA.status,
      categories: planeA.categoryScores || {},
      checks:     planeA.checks || [],
      alerts:     planeA.activeAlerts || [],
      summary:    planeA.summary || {},
      ...(planeA.error ? { error: planeA.error } : {}),
    },

    productIntegrity: {
      score:   planeB.overallScore,
      status:  planeB.status,
      checks:  planeB.checks || [],
      summary: planeB.summary || {},
      ...(planeB.error ? { error: planeB.error } : {}),
    },

    // Flatten all alerts for the dashboard
    alerts: planeA.activeAlerts || [],

    // Combined summary
    summary: {
      dataPass:     (planeA.summary?.pass    || 0),
      dataWarn:     (planeA.summary?.warn    || 0),
      dataFail:     (planeA.summary?.fail    || 0),
      dataError:    (planeA.summary?.error   || 0),
      productPass:  (planeB.summary?.pass    || 0),
      productWarn:  (planeB.summary?.warn    || 0),
      productFail:  (planeB.summary?.fail    || 0),
      productError: (planeB.summary?.error   || 0),
    },
  };

  await exportHealthJson(payload);
  await manageAlert(overallStatus, prevOverall);

  console.log(`[MONITOR] Done in ${Date.now() - t0}ms`);
  console.log('[MONITOR] ══════════════════════════════════════════');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error('[MONITOR] Fatal:', err); process.exit(1); });
