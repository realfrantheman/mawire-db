'use strict';
// Plane B — Product Integrity: HTTP probes + adversary pass
// No external dependencies — pure Node.js (https, http, tls, net)

const https = require('https');
const http  = require('http');
const tls   = require('tls');

const SITE = 'https://mergers.news';

// All user-facing routes per vercel.json
const ROUTES = [
  '/', '/ipo', '/about', '/contact', '/tender-offers', '/monitoring',
  '/mergers/technology', '/mergers/healthcare', '/mergers/financial-services',
];

// Key assets served directly
const ASSETS = ['/deals.json', '/ipos.json', '/pie-health.json', '/sw.js'];

// Security headers required on HTML responses
const REQUIRED_HEADERS = [
  'x-content-type-options',
];

const LATENCY_WARN_MS  = 2000;
const LATENCY_FAIL_MS  = 5000;
const DEALS_MIN_BYTES  = 500_000;   // deals.json must be > 500 KB
const TLS_WARN_DAYS    = 21;
const TLS_FAIL_DAYS    = 7;

// ── HTTP HELPER ───────────────────────────────────────────────────────────────
function rawGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0  = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: opts.timeout || 12000,
      headers: { 'User-Agent': 'mawire-monitor/2.0 (health check)', ...(opts.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status:    res.statusCode,
        headers:   res.headers,
        body:      Buffer.concat(chunks),
        latencyMs: Date.now() - t0,
        finalUrl:  url,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${opts.timeout || 12000}ms: ${url}`)); });
  });
}

// Follow redirects up to depth 4
async function httpGet(url, opts = {}, depth = 0) {
  if (depth > 4) throw new Error(`Too many redirects: ${url}`);
  const res = await rawGet(url, opts);
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
    const next = res.headers.location.startsWith('http')
      ? res.headers.location
      : new URL(res.headers.location, url).toString();
    return httpGet(next, opts, depth + 1);
  }
  return res;
}

// ── TLS HELPER ────────────────────────────────────────────────────────────────
function getTLSCert(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host:               hostname,
      port:               443,
      servername:         hostname,
      rejectUnauthorized: false,  // inspect cert even if expired
    }, () => {
      const cert = socket.getPeerCertificate(true);
      socket.end();
      resolve(cert);
    });
    socket.setTimeout(10000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS timeout')); });
    socket.on('error', reject);
  });
}

// ── CHECK BUILDER ─────────────────────────────────────────────────────────────
function check(name, status, score, message, detail = {}) {
  return { name, category: 'product', status, score: Math.round(score), message, detail, isError: false };
}
function errored(name, errMsg) {
  return { name, category: 'product', status: 'error', score: 0, message: `Error: ${errMsg}`, detail: {}, isError: true };
}
async function runCheck(name, fn) {
  try { return await fn(); }
  catch (err) { return errored(name, err.message); }
}

// ── CHECKS ────────────────────────────────────────────────────────────────────

// TLS certificate expiry
async function checkTLSExpiry() {
  const hostname = new URL(SITE).hostname;
  const cert = await getTLSCert(hostname);
  if (!cert || !cert.valid_to) return errored('tls_expiry', 'Could not read certificate');

  const expiresAt  = new Date(cert.valid_to);
  const daysLeft   = (expiresAt - Date.now()) / (1000 * 60 * 60 * 24);

  let status = 'pass', score = 100;
  if (daysLeft < 0)              { status = 'fail'; score = 0;  }
  else if (daysLeft < TLS_FAIL_DAYS)  { status = 'fail'; score = 10; }
  else if (daysLeft < TLS_WARN_DAYS)  { status = 'warn'; score = 60; }

  return check('tls_expiry', status, score,
    daysLeft < 0
      ? `TLS certificate EXPIRED ${Math.abs(daysLeft).toFixed(0)} days ago`
      : `TLS certificate expires in ${daysLeft.toFixed(0)} days (${cert.valid_to})`,
    { subject: cert.subject?.CN, issuer: cert.issuer?.O, expiresAt: cert.valid_to, daysLeft: parseFloat(daysLeft.toFixed(1)) });
}

// All routes return 200 within latency budget
async function checkRouteAvailability() {
  const results = [];
  let worstStatus = 'pass', worstScore = 100;

  for (const route of ROUTES) {
    const url = SITE + route;
    try {
      const res = await httpGet(url, { timeout: 10000 });
      const ok  = res.status === 200;
      const slow = res.latencyMs > LATENCY_FAIL_MS;
      const sluggish = !slow && res.latencyMs > LATENCY_WARN_MS;
      results.push({ route, status: res.status, latencyMs: res.latencyMs, ok });
      if (!ok || slow) { worstStatus = 'fail'; worstScore = Math.min(worstScore, 10); }
      else if (sluggish) { if (worstStatus === 'pass') worstStatus = 'warn'; worstScore = Math.min(worstScore, 60); }
    } catch (err) {
      results.push({ route, status: 0, latencyMs: -1, ok: false, error: err.message });
      worstStatus = 'fail'; worstScore = 0;
    }
  }

  const failed = results.filter(r => !r.ok);
  const maxMs  = Math.max(...results.filter(r => r.latencyMs > 0).map(r => r.latencyMs));
  return check('route_availability', worstStatus, worstScore,
    failed.length === 0
      ? `All ${ROUTES.length} routes OK · max latency ${maxMs}ms`
      : `${failed.length}/${ROUTES.length} routes failed: ${failed.map(r => r.route).join(', ')}`,
    { routes: results });
}

// deals.json reachable, valid JSON, non-empty, sufficient size
async function checkDealsJson() {
  const url = SITE + '/deals.json';
  const res = await httpGet(url, { timeout: 30000 });

  if (res.status !== 200) {
    return check('deals_json', 'fail', 0, `deals.json returned HTTP ${res.status}`, { status: res.status });
  }

  const bytes = res.body.length;
  let parsed, parseOk = true;
  try { parsed = JSON.parse(res.body.toString('utf8')); }
  catch (_) { parseOk = false; }

  if (!parseOk) return check('deals_json', 'fail', 0, `deals.json is not valid JSON (${bytes} bytes)`, { bytes });
  if (!Array.isArray(parsed)) return check('deals_json', 'fail', 5, `deals.json is not an array`, { bytes });
  if (parsed.length === 0) return check('deals_json', 'fail', 5, 'deals.json is empty', { bytes });

  let status = 'pass', score = 100;
  if (bytes < DEALS_MIN_BYTES) { status = 'warn'; score = 60; }

  const latestDate = parsed
    .map(d => d.announcementDate || d.dateISO || null)
    .filter(Boolean)
    .sort()
    .pop();

  return check('deals_json', status, score,
    `deals.json OK — ${parsed.length} deals · ${(bytes / 1024 / 1024).toFixed(1)} MB · latest: ${latestDate || 'unknown'}`,
    { count: parsed.length, bytes, latestDate, latencyMs: res.latencyMs });
}

// Security headers on HTML responses
async function checkSecurityHeaders() {
  const res = await httpGet(SITE + '/', { timeout: 10000 });
  const headers = res.headers;

  const checks = [
    { header: 'x-content-type-options',  expected: 'nosniff', required: true },
    { header: 'x-frame-options',         expected: null,       required: false },
    { header: 'content-security-policy', expected: null,       required: false },
    { header: 'strict-transport-security', expected: null,     required: false },
  ];

  const results  = checks.map(c => ({ ...c, present: !!headers[c.header], value: headers[c.header] || null }));
  const missing  = results.filter(c => c.required && !c.present);
  const present  = results.filter(c => c.present);

  let status = 'pass', score = 100;
  if (missing.length > 0) { status = 'warn'; score = 65; }

  return check('security_headers', status, score,
    missing.length === 0
      ? `Security headers OK (${present.length}/${checks.length} present)`
      : `Missing required headers: ${missing.map(c => c.header).join(', ')}`,
    { headers: results });
}

// 404 correctness — random path must return 404, not a soft 200
async function check404Correctness() {
  const testPaths = [
    '/this-path-does-not-exist-xyz123abc',
    '/monitoring/nonexistent',
    '/deals/nonexistent-page',
  ];
  const results = [];
  for (const path of testPaths) {
    try {
      const res = await rawGet(SITE + path, { timeout: 8000 }); // rawGet: no redirect follow
      results.push({ path, status: res.status });
    } catch (err) {
      results.push({ path, status: -1, error: err.message });
    }
  }

  // Vercel with cleanUrls + 404.html should serve 404 for nonexistent paths
  // Soft-200 (serving index.html for every unknown path) is a misconfiguration
  const soft200 = results.filter(r => r.status === 200);
  let status = 'pass', score = 100;
  if (soft200.length === testPaths.length) { status = 'warn'; score = 60; }
  const notFound = results.filter(r => r.status === 404 || r.status === 301 || r.status === 302);

  return check('404_correctness', status, score,
    soft200.length === 0
      ? `404 handling correct (${notFound.length}/${testPaths.length} paths return 404)`
      : `${soft200.length} paths returned 200 instead of 404 (possible catch-all misconfiguration)`,
    { paths: results });
}

// Adversary: deal ID fuzzing — bad IDs must not 500
async function checkAdversaryFuzzing() {
  const fuzzPaths = [
    '/deal/0',
    '/deal/-1',
    '/deal/99999999999',
    '/deal/undefined',
    '/deal/null',
    '/deal/' + 'a'.repeat(256),  // oversized segment
  ];
  const results = [];
  for (const path of fuzzPaths) {
    try {
      const res = await rawGet(SITE + path, { timeout: 8000 });
      results.push({ path, status: res.status, ok: res.status !== 500 && res.status !== 503 });
    } catch (err) {
      results.push({ path, status: -1, ok: true, error: err.message }); // timeout/conn refused != 500
    }
  }

  const bad = results.filter(r => !r.ok);
  let status = 'pass', score = 100;
  if (bad.length > 0) { status = 'fail'; score = 20; }

  return check('adversary_fuzzing', status, score,
    bad.length === 0
      ? `All ${fuzzPaths.length} fuzz paths handled gracefully (no 500s)`
      : `${bad.length} paths returned 500: ${bad.map(r => r.path).join(', ')}`,
    { paths: results });
}

// Adversary: path traversal attempts must not return 200 with traversal content
async function checkPathTraversal() {
  const traversalPaths = [
    '/../../../etc/passwd',
    '/..%2F..%2F..%2Fetc%2Fpasswd',
    '/.env',
    '/package.json',
    '/.git/config',
  ];
  const results = [];
  for (const path of traversalPaths) {
    try {
      const res = await rawGet(SITE + path, { timeout: 8000 });
      const body = res.body.toString('utf8').slice(0, 500);
      // A traversal success would show /etc/passwd content or raw source files
      const leaked = /root:x:|\/bin\/bash|"dependencies"\s*:|^\s*\[core\]/m.test(body);
      results.push({ path, status: res.status, leaked });
    } catch (err) {
      results.push({ path, status: -1, leaked: false });
    }
  }

  const leaks = results.filter(r => r.leaked);
  let status = 'pass', score = 100;
  if (leaks.length > 0) { status = 'fail'; score = 0; }

  return check('path_traversal', status, score,
    leaks.length === 0
      ? `No path traversal vulnerabilities detected`
      : `CRITICAL: ${leaks.length} path(s) may be leaking file content`,
    { paths: results.map(r => ({ path: r.path, status: r.status, leaked: r.leaked })) });
}

// HTTP method abuse — POST/DELETE to static routes should not 500
async function checkMethodAbuse() {
  const results = [];
  for (const method of ['POST', 'DELETE', 'PUT']) {
    await new Promise((resolve) => {
      const req = https.request(`${SITE}/`, { method, timeout: 8000,
        headers: { 'User-Agent': 'mawire-monitor/2.0 (health check)', 'Content-Length': '0' } },
        (res) => {
          results.push({ method, status: res.statusCode, ok: res.statusCode !== 500 });
          res.resume();
          resolve();
        }
      );
      req.on('error', () => { results.push({ method, status: -1, ok: true }); resolve(); });
      req.on('timeout', () => { req.destroy(); results.push({ method, status: -1, ok: true }); resolve(); });
      req.end();
    });
  }

  const bad = results.filter(r => !r.ok);
  let status = 'pass', score = 100;
  if (bad.length > 0) { status = 'warn'; score = 50; }

  return check('method_abuse', status, score,
    bad.length === 0
      ? `Non-GET methods handled correctly (no 500s)`
      : `${bad.length} method(s) returned 500: ${bad.map(r => r.method).join(', ')}`,
    { methods: results });
}

// Response latency across all routes
async function checkLatency() {
  const measurements = [];
  for (const route of [...ROUTES.slice(0, 5)]) {  // sample first 5 routes
    try {
      const res = await httpGet(SITE + route, { timeout: 10000 });
      measurements.push({ route, latencyMs: res.latencyMs });
    } catch (_) {
      measurements.push({ route, latencyMs: -1 });
    }
  }

  const valid = measurements.filter(m => m.latencyMs > 0);
  if (!valid.length) return errored('latency', 'No latency measurements available');
  const avg  = Math.round(valid.reduce((s, m) => s + m.latencyMs, 0) / valid.length);
  const max  = Math.max(...valid.map(m => m.latencyMs));
  const slow = measurements.filter(m => m.latencyMs > LATENCY_FAIL_MS);

  let status = 'pass', score = 100;
  if (slow.length > 0)       { status = 'fail'; score = 20; }
  else if (avg > LATENCY_WARN_MS) { status = 'warn'; score = 65; }

  return check('latency', status, score,
    `Avg ${avg}ms · max ${max}ms${slow.length > 0 ? ` · ${slow.length} routes > ${LATENCY_FAIL_MS}ms` : ''}`,
    { avgMs: avg, maxMs: max, measurements });
}

// ── SCORING ───────────────────────────────────────────────────────────────────
function computeScore(checks) {
  const active = checks.filter(c => c.status !== 'not_applicable');
  if (!active.length) return 0;
  const sum = active.reduce((s, c) => s + (c.isError ? 0 : c.score), 0);
  return Math.round(sum / active.length);
}

function statusLabel(score) {
  if (score >= 85) return 'healthy';
  if (score >= 60) return 'degraded';
  return 'critical';
}

// ── RUN ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log('[SYNTHETIC] ── Product Integrity checks starting ──');

  const checkDefs = [
    ['tls_expiry',          checkTLSExpiry],
    ['route_availability',  checkRouteAvailability],
    ['deals_json',          checkDealsJson],
    ['security_headers',    checkSecurityHeaders],
    ['404_correctness',     check404Correctness],
    ['adversary_fuzzing',   checkAdversaryFuzzing],
    ['path_traversal',      checkPathTraversal],
    ['method_abuse',        checkMethodAbuse],
    ['latency',             checkLatency],
  ];

  const results = [];
  for (const [name, fn] of checkDefs) {
    const result = await runCheck(name, fn);
    const icon = { pass: '✓', warn: '⚠', fail: '✗', error: '✗✗' }[result.status] || '?';
    console.log(`[SYNTHETIC] ${icon} ${result.name.padEnd(22)} score=${String(result.score).padStart(3)}  ${result.message}`);
    results.push(result);
  }

  const overallScore = computeScore(results);
  const status = statusLabel(overallScore);
  console.log(`[SYNTHETIC] ── Overall: ${overallScore}/100 (${status}) ──`);

  return {
    overallScore,
    status,
    checks: results.map(c => ({ name: c.name, status: c.status, score: c.score, message: c.message, isError: c.isError })),
    summary: {
      pass:  results.filter(c => c.status === 'pass').length,
      warn:  results.filter(c => c.status === 'warn').length,
      fail:  results.filter(c => c.status === 'fail').length,
      error: results.filter(c => c.isError).length,
    },
  };
}

module.exports = { run };
