/**
 * mergers.news — Public REST API
 * Public deal endpoints intentionally expose the same verified population as
 * the static database export: canonical deals with a verified transaction
 * review under the current publication rule.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const compression = require('compression');

const app = express();
const PUBLIC_REVIEW_RULE_VERSION = process.env.TRANSACTION_REVIEW_RULE_VERSION || 'strict-control-v3';
const PUBLIC_GATE = `EXISTS (
  SELECT 1 FROM deal_transaction_reviews tr
  WHERE tr.deal_id = d.id
    AND tr.status = 'verified'
    AND tr.rule_version = '${PUBLIC_REVIEW_RULE_VERSION.replace(/'/g, "''")}'
)`;

function dbSsl() {
  if (process.env.DATABASE_SSL_ALLOW_SELF_SIGNED === 'true') return { rejectUnauthorized: false };
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false;
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: dbSsl(),
  statement_timeout: 30000,
  query_timeout: 30000,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
});

db.on('error', error => console.error('[API] idle database client error:', error.message));
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = [
  'https://mergers.news',
  'https://www.mergers.news',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  next();
});

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests — please retry after 15 minutes', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
}));

function ok(res, data, meta = {}) {
  res.json({ success: true, ...meta, data });
}

function err(res, status, message, code) {
  res.status(status).json({ success: false, error: message, code });
}

function paginate(query) {
  const pageRaw = Number.parseInt(query.page || '1', 10);
  const limitRaw = Number.parseInt(query.limit || '50', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 100) : 50;
  return { page, limit, offset: (page - 1) * limit };
}

function validDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function reliableName(value) {
  if (!value) return null;
  return /^(unknown|undisclosed(?: buyer| acquirer| target)?|acquirer.*see filing|target.*see filing|disclosed in filing)$/i.test(String(value).trim())
    ? null
    : value;
}

function formatDeal(row) {
  const cents = row.deal_value === null || row.deal_value === undefined ? null : Number(row.deal_value);
  const usd = cents === null || !Number.isFinite(cents) ? null : cents / 100;
  return {
    id: row.id,
    headline: row.headline,
    acquirer: reliableName(row.acquirer_name) || reliableName(row.extracted_acquirer_name),
    acquirer_id: row.acquirer_id || null,
    acquirer_country: row.acquirer_country || null,
    target: reliableName(row.target_name) || reliableName(row.extracted_target_name),
    target_id: row.target_id || null,
    target_country: row.target_country || null,
    deal_type: row.reviewed_deal_type || row.deal_type,
    status: row.status,
    deal_value: usd,
    deal_value_b: usd === null ? null : `${(usd / 1e9).toFixed(2)}B`,
    per_share_value: row.per_share_value,
    premium_pct: row.premium_pct,
    currency: row.currency || 'USD',
    announcement_date: row.announcement_date,
    close_date: row.close_date,
    sector: row.sector,
    region: row.region,
    country: row.country,
    is_cross_border: row.is_cross_border,
    is_private_equity: row.is_private_equity,
    is_hostile: row.is_hostile,
    tags: row.tags || [],
    ai_summary: row.ai_summary,
    source_confidence: row.source_confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    const count = await db.query(`SELECT COUNT(*) FROM deals d WHERE d.canonical_id IS NULL AND ${PUBLIC_GATE}`);
    ok(res, {
      status: 'ok',
      deals_count: Number.parseInt(count.rows[0].count, 10),
      review_rule_version: PUBLIC_REVIEW_RULE_VERSION,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[API] Health error:', error.message);
    err(res, 503, 'Database unavailable', 'DB_ERROR');
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const cacheKey = `api_stats:${PUBLIC_REVIEW_RULE_VERSION}`;
    const cached = await db.query('SELECT value FROM stats_cache WHERE key = $1 AND expires_at > NOW()', [cacheKey]);
    if (cached.rows.length) return ok(res, cached.rows[0].value);

    const [total, byYear, bySector, byType, byStatus, largest] = await Promise.all([
      db.query(`SELECT COUNT(*) AS count, SUM(d.deal_value)/100.0 AS total_value FROM deals d WHERE d.canonical_id IS NULL AND ${PUBLIC_GATE}`),
      db.query(`SELECT EXTRACT(YEAR FROM d.announcement_date)::int AS year, COUNT(*) AS deals, SUM(d.deal_value)/100.0 AS value FROM deals d WHERE d.canonical_id IS NULL AND d.announcement_date IS NOT NULL AND ${PUBLIC_GATE} GROUP BY 1 ORDER BY 1`),
      db.query(`SELECT d.sector, COUNT(*) AS deals FROM deals d WHERE d.canonical_id IS NULL AND d.sector IS NOT NULL AND ${PUBLIC_GATE} GROUP BY d.sector ORDER BY deals DESC LIMIT 15`),
      db.query(`SELECT d.deal_type, COUNT(*) AS deals FROM deals d WHERE d.canonical_id IS NULL AND d.deal_type IS NOT NULL AND ${PUBLIC_GATE} GROUP BY d.deal_type ORDER BY deals DESC`),
      db.query(`SELECT d.status, COUNT(*) AS deals FROM deals d WHERE d.canonical_id IS NULL AND d.status IS NOT NULL AND ${PUBLIC_GATE} GROUP BY d.status ORDER BY deals DESC`),
      db.query(`SELECT d.id, d.headline, d.deal_value/100.0 AS value, d.announcement_date, a.name AS acquirer, t.name AS target, d.sector FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id LEFT JOIN companies t ON d.target_id=t.id WHERE d.canonical_id IS NULL AND d.deal_value IS NOT NULL AND ${PUBLIC_GATE} ORDER BY d.deal_value DESC, d.id LIMIT 10`),
    ]);

    const stats = {
      total_deals: Number.parseInt(total.rows[0].count, 10),
      total_value_usd: Number.parseFloat(total.rows[0].total_value) || 0,
      by_year: byYear.rows,
      by_sector: bySector.rows,
      by_type: byType.rows,
      by_status: byStatus.rows,
      largest_deals: largest.rows,
      review_rule_version: PUBLIC_REVIEW_RULE_VERSION,
      generated_at: new Date().toISOString(),
    };

    await db.query(`INSERT INTO stats_cache (key,value,computed_at,expires_at) VALUES ($1,$2,NOW(),NOW()+INTERVAL '1 hour') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,computed_at=NOW(),expires_at=EXCLUDED.expires_at`, [cacheKey, JSON.stringify(stats)]);
    return ok(res, stats);
  } catch (error) {
    console.error('[API] Stats error:', error.message);
    return err(res, 500, 'Could not compute statistics', 'STATS_ERROR');
  }
});

app.get('/api/deals', async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query);
    const { q, sector, status, deal_type, region, country, min_value, max_value, date_from, date_to, acquirer, target, sort = 'date_desc' } = req.query;
    if (date_from && !validDate(date_from)) return err(res, 400, 'Invalid date_from; expected YYYY-MM-DD', 'INVALID_DATE');
    if (date_to && !validDate(date_to)) return err(res, 400, 'Invalid date_to; expected YYYY-MM-DD', 'INVALID_DATE');

    const conditions = [`d.canonical_id IS NULL`, PUBLIC_GATE];
    const params = [];
    let p = 1;
    if (q) { conditions.push(`(d.headline ILIKE $${p} OR a.name ILIKE $${p} OR t.name ILIKE $${p})`); params.push(`%${q}%`); p++; }
    if (sector) { conditions.push(`d.sector ILIKE $${p}`); params.push(`%${sector}%`); p++; }
    if (status) { conditions.push(`d.status = $${p}`); params.push(status); p++; }
    if (deal_type) { conditions.push(`d.deal_type = $${p}`); params.push(deal_type); p++; }
    if (region) { conditions.push(`d.region ILIKE $${p}`); params.push(`%${region}%`); p++; }
    if (country) { conditions.push(`d.country = $${p}`); params.push(String(country).toUpperCase()); p++; }
    if (acquirer) { conditions.push(`a.name ILIKE $${p}`); params.push(`%${acquirer}%`); p++; }
    if (target) { conditions.push(`t.name ILIKE $${p}`); params.push(`%${target}%`); p++; }

    const min = Number.parseFloat(min_value);
    const max = Number.parseFloat(max_value);
    if (min_value !== undefined && Number.isFinite(min) && min >= 0) { conditions.push(`d.deal_value >= $${p}`); params.push(Math.round(min * 100)); p++; }
    if (max_value !== undefined && Number.isFinite(max) && max >= 0) { conditions.push(`d.deal_value <= $${p}`); params.push(Math.round(max * 100)); p++; }
    if (date_from) { conditions.push(`d.announcement_date >= $${p}`); params.push(date_from); p++; }
    if (date_to) { conditions.push(`d.announcement_date <= $${p}`); params.push(date_to); p++; }

    const sorts = {
      date_desc: 'd.announcement_date DESC NULLS LAST, d.id',
      date_asc: 'd.announcement_date ASC NULLS LAST, d.id',
      value_desc: 'd.deal_value DESC NULLS LAST, d.id',
      value_asc: 'd.deal_value ASC NULLS LAST, d.id',
      confidence: 'd.source_confidence DESC, d.announcement_date DESC NULLS LAST, d.id',
    };
    const orderBy = sorts[sort] || sorts.date_desc;
    const where = conditions.join(' AND ');

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id LEFT JOIN companies t ON d.target_id=t.id WHERE ${where}`, params),
      db.query(`SELECT d.*,a.name AS acquirer_name,a.country AS acquirer_country,t.name AS target_name,t.country AS target_country,tr.transaction_type AS reviewed_deal_type FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id LEFT JOIN companies t ON d.target_id=t.id JOIN deal_transaction_reviews tr ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version='${PUBLIC_REVIEW_RULE_VERSION.replace(/'/g, "''")}' WHERE ${where} ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}`, [...params, limit, offset]),
    ]);

    const total = Number.parseInt(countRes.rows[0].count, 10);
    return ok(res, dataRes.rows.map(formatDeal), { pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('[API] Deals error:', error.message);
    return err(res, 500, 'Could not fetch deals', 'DEALS_ERROR');
  }
});

app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return err(res, 400, 'Invalid deal ID format', 'INVALID_ID');

    const dealRes = await db.query(`SELECT d.*,a.name AS acquirer_name,a.country AS acquirer_country,t.name AS target_name,t.country AS target_country,tr.transaction_type AS reviewed_deal_type FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id LEFT JOIN companies t ON d.target_id=t.id JOIN deal_transaction_reviews tr ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version='${PUBLIC_REVIEW_RULE_VERSION.replace(/'/g, "''")}' WHERE d.id=$1 AND d.canonical_id IS NULL`, [id]);
    if (!dealRes.rows.length) return err(res, 404, 'Deal not found', 'NOT_FOUND');

    const [sources, filings, comparables] = await Promise.all([
      db.query('SELECT source_type,source_name,source_url,source_date FROM deal_sources WHERE deal_id=$1 ORDER BY confidence DESC NULLS LAST,source_date DESC NULLS LAST,created_at DESC,id', [id]),
      db.query('SELECT filing_type,document_url,edgar_url,accession_no,filing_date FROM filings WHERE deal_id=$1 ORDER BY filing_date DESC NULLS LAST,created_at DESC,id', [id]),
      db.query(`SELECT d.id,d.headline,d.deal_value/100.0 AS deal_value,d.announcement_date,d.sector,a.name AS acquirer_name,t.name AS target_name FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id LEFT JOIN companies t ON d.target_id=t.id WHERE d.canonical_id IS NULL AND d.id<>$1 AND d.sector=(SELECT sector FROM deals WHERE id=$1) AND d.deal_value IS NOT NULL AND ${PUBLIC_GATE} AND ABS(COALESCE(d.deal_value,0)-COALESCE((SELECT deal_value FROM deals WHERE id=$1),0))/NULLIF(GREATEST(COALESCE(d.deal_value,1),(SELECT COALESCE(deal_value,1) FROM deals WHERE id=$1)),0)<0.7 ORDER BY ABS(COALESCE(d.deal_value,0)-COALESCE((SELECT deal_value FROM deals WHERE id=$1),0)),d.id LIMIT 5`, [id]),
    ]);

    return ok(res, { ...formatDeal(dealRes.rows[0]), sources: sources.rows, filings: filings.rows, comparables: comparables.rows });
  } catch (error) {
    console.error('[API] Deal detail error:', error.message);
    return err(res, 500, 'Could not fetch deal', 'DEAL_ERROR');
  }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  const raw = Number.parseInt(req.query.limit || '20', 10);
  const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 100) : 20;
  if (!q || q.trim().length < 2) return err(res, 400, 'Query too short', 'QUERY_TOO_SHORT');
  if (q.length > 200) return err(res, 400, 'Query too long', 'QUERY_TOO_LONG');

  try {
    const start = Date.now();
    const results = await db.query(`
      SELECT d.*,a.name AS acquirer_name,a.country AS acquirer_country,t.name AS target_name,t.country AS target_country,tr.transaction_type AS reviewed_deal_type,
             ts_rank(to_tsvector('english',COALESCE(d.headline,'')||' '||COALESCE(a.name,'')||' '||COALESCE(t.name,'')),plainto_tsquery('english',$1)) AS rank
      FROM deals d
      LEFT JOIN companies a ON d.acquirer_id=a.id
      LEFT JOIN companies t ON d.target_id=t.id
      JOIN deal_transaction_reviews tr ON tr.deal_id=d.id AND tr.status='verified' AND tr.rule_version='${PUBLIC_REVIEW_RULE_VERSION.replace(/'/g, "''")}'
      WHERE d.canonical_id IS NULL AND (
        to_tsvector('english',COALESCE(d.headline,'')||' '||COALESCE(a.name,'')||' '||COALESCE(t.name,'')) @@ plainto_tsquery('english',$1)
        OR d.headline ILIKE $2 OR a.name ILIKE $2 OR t.name ILIKE $2
      )
      ORDER BY rank DESC,d.deal_value DESC NULLS LAST,d.id
      LIMIT $3
    `, [q, `%${q}%`, limit]);
    const duration = Date.now() - start;
    db.query('INSERT INTO search_log (query,result_count,duration_ms) VALUES ($1,$2,$3)', [q.slice(0, 100), results.rows.length, duration]).catch(() => {});
    return ok(res, results.rows.map(formatDeal), { query: q, count: results.rows.length, duration_ms: duration });
  } catch (error) {
    console.error('[API] Search error:', error.message);
    return err(res, 500, 'Search failed', 'SEARCH_ERROR');
  }
});

app.get('/api/companies', async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query);
    const { q, country, sector } = req.query;
    const conditions = [`EXISTS (SELECT 1 FROM deals d WHERE d.canonical_id IS NULL AND ${PUBLIC_GATE} AND (d.acquirer_id=c.id OR d.target_id=c.id))`];
    const params = [];
    let p = 1;
    if (q) { conditions.push(`c.name ILIKE $${p}`); params.push(`%${q}%`); p++; }
    if (country) { conditions.push(`c.country = $${p}`); params.push(String(country).toUpperCase()); p++; }
    if (sector) { conditions.push(`c.industry ILIKE $${p}`); params.push(`%${sector}%`); p++; }
    const where = conditions.join(' AND ');

    const [count, data] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM companies c WHERE ${where}`, params),
      db.query(`SELECT c.*,
        (SELECT COUNT(*) FROM deals d WHERE d.acquirer_id=c.id AND d.canonical_id IS NULL AND ${PUBLIC_GATE}) AS deals_as_acquirer,
        (SELECT COUNT(*) FROM deals d WHERE d.target_id=c.id AND d.canonical_id IS NULL AND ${PUBLIC_GATE}) AS deals_as_target
        FROM companies c WHERE ${where}
        ORDER BY ((SELECT COUNT(*) FROM deals d WHERE d.acquirer_id=c.id AND d.canonical_id IS NULL AND ${PUBLIC_GATE}) + (SELECT COUNT(*) FROM deals d WHERE d.target_id=c.id AND d.canonical_id IS NULL AND ${PUBLIC_GATE})) DESC,c.name,c.id
        LIMIT $${p} OFFSET $${p + 1}`, [...params, limit, offset]),
    ]);
    const total = Number.parseInt(count.rows[0].count, 10);
    return ok(res, data.rows, { pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('[API] Companies error:', error.message);
    return err(res, 500, 'Could not fetch companies', 'COMPANIES_ERROR');
  }
});

app.get('/api/companies/:id', async (req, res) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return err(res, 400, 'Invalid company ID format', 'INVALID_ID');
    const company = await db.query(`SELECT c.* FROM companies c WHERE c.id=$1 AND EXISTS (SELECT 1 FROM deals d WHERE d.canonical_id IS NULL AND ${PUBLIC_GATE} AND (d.acquirer_id=c.id OR d.target_id=c.id))`, [req.params.id]);
    if (!company.rows.length) return err(res, 404, 'Company not found', 'NOT_FOUND');

    const [asAcquirer, asTarget] = await Promise.all([
      db.query(`SELECT d.id,d.headline,d.deal_value/100.0 AS deal_value,d.announcement_date,d.status,d.sector,t.name AS target_name FROM deals d LEFT JOIN companies t ON d.target_id=t.id WHERE d.acquirer_id=$1 AND d.canonical_id IS NULL AND ${PUBLIC_GATE} ORDER BY d.announcement_date DESC NULLS LAST,d.id LIMIT 20`, [req.params.id]),
      db.query(`SELECT d.id,d.headline,d.deal_value/100.0 AS deal_value,d.announcement_date,d.status,d.sector,a.name AS acquirer_name FROM deals d LEFT JOIN companies a ON d.acquirer_id=a.id WHERE d.target_id=$1 AND d.canonical_id IS NULL AND ${PUBLIC_GATE} ORDER BY d.announcement_date DESC NULLS LAST,d.id LIMIT 20`, [req.params.id]),
    ]);
    return ok(res, { ...company.rows[0], deals_as_acquirer: asAcquirer.rows, deals_as_target: asTarget.rows });
  } catch (error) {
    console.error('[API] Company error:', error.message);
    return err(res, 500, 'Could not fetch company', 'COMPANY_ERROR');
  }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const data = await db.query(`SELECT d.sector,COUNT(*) AS deal_count,SUM(d.deal_value)/100.0 AS total_value,AVG(d.deal_value)/100.0 AS avg_value,MAX(d.deal_value)/100.0 AS max_value,COUNT(*) FILTER (WHERE d.status='Completed') AS completed,MIN(d.announcement_date) AS earliest,MAX(d.announcement_date) AS latest FROM deals d WHERE d.canonical_id IS NULL AND d.sector IS NOT NULL AND ${PUBLIC_GATE} GROUP BY d.sector ORDER BY deal_count DESC,d.sector`);
    return ok(res, data.rows);
  } catch (error) {
    console.error('[API] Sectors error:', error.message);
    return err(res, 500, 'Could not fetch sectors', 'SECTORS_ERROR');
  }
});

app.use((req, res) => err(res, 404, `Route not found: ${req.method} ${req.path}`, 'NOT_FOUND'));
app.use((error, req, res, next) => {
  if (error && error.message === 'Not allowed by CORS') return err(res, 403, 'Origin not allowed', 'CORS_DENIED');
  console.error('[API] Unhandled middleware error:', error?.stack || error);
  return err(res, 500, 'Internal server error', 'INTERNAL_ERROR');
});

const PORT = Number(process.env.PORT || 3001);
if (require.main === module) {
  app.listen(PORT, () => console.log(`[API] mergers.news API running on port ${PORT}`));
}

module.exports = app;
module.exports.formatDeal = formatDeal;
module.exports.paginate = paginate;
module.exports.validDate = validDate;
module.exports.PUBLIC_REVIEW_RULE_VERSION = PUBLIC_REVIEW_RULE_VERSION;
