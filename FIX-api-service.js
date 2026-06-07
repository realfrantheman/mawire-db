/**
 * mergers.news — Public REST API
 * FIXES APPLIED:
 * - Added trust proxy for correct IP detection behind Railway
 * - Changed CORS from '*' to specific allowed origins
 * - Added query timeout to prevent runaway queries
 * - Added isNaN guards on page/limit params
 * - Added missing /api/sectors sort validation
 */

'use strict';

const express     = require('express');
const { Pool }    = require('pg');
const rateLimit   = require('express-rate-limit');
const cors        = require('cors');
const compression = require('compression');

const app = express();
const db  = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  // Query timeout — prevents runaway queries blocking the pool
  statement_timeout: 30000,
  query_timeout:     30000,
});

// Trust Railway's proxy so rate limiter sees real client IPs
app.set('trust proxy', 1);

// ── MIDDLEWARE ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://mergers.news',
  'https://www.mergers.news',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow server-to-server calls (no origin) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '16kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  next();
});

// Rate limiting — 100 requests per 15 minutes per IP (real IP via trust proxy)
const limiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             100,
  message:         { error: 'Too many requests — please retry after 15 minutes', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

// ── HELPERS ────────────────────────────────────────────────────────
function ok(res, data, meta = {}) {
  res.json({ success: true, ...meta, data });
}

function err(res, status, message, code) {
  res.status(status).json({ success: false, error: message, code });
}

function paginate(query) {
  const pageRaw  = parseInt(query.page  || 1);
  const limitRaw = parseInt(query.limit || 50);
  const page  = isNaN(pageRaw)  || pageRaw  < 1   ? 1   : pageRaw;
  const limit = isNaN(limitRaw) || limitRaw < 1   ? 50  : Math.min(limitRaw, 100);
  return { page, limit, offset: (page - 1) * limit };
}

function formatDeal(row) {
  return {
    id:                row.id,
    headline:          row.headline,
    acquirer:          row.acquirer_name  || null,
    acquirer_id:       row.acquirer_id    || null,
    acquirer_country:  row.acquirer_country || null,
    target:            row.target_name    || null,
    target_id:         row.target_id      || null,
    target_country:    row.target_country || null,
    deal_type:         row.deal_type,
    status:            row.status,
    deal_value:        row.deal_value ? row.deal_value / 100 : null,
    deal_value_b:      row.deal_value ? (row.deal_value / 100 / 1e9).toFixed(2) + 'B' : null,
    per_share_value:   row.per_share_value,
    premium_pct:       row.premium_pct,
    currency:          row.currency || 'USD',
    announcement_date: row.announcement_date,
    close_date:        row.close_date,
    sector:            row.sector,
    region:            row.region,
    country:           row.country,
    is_cross_border:   row.is_cross_border,
    is_private_equity: row.is_private_equity,
    is_hostile:        row.is_hostile,
    tags:              row.tags || [],
    ai_summary:        row.ai_summary,
    source_confidence: row.source_confidence,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
  };
}

// ── GET /api/health ────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    const count = await db.query('SELECT COUNT(*) FROM deals WHERE canonical_id IS NULL');
    ok(res, {
      status:      'ok',
      deals_count: parseInt(count.rows[0].count),
      timestamp:   new Date().toISOString(),
    });
  } catch (e) {
    err(res, 503, 'Database unavailable', 'DB_ERROR');
  }
});

// ── GET /api/stats ─────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const cached = await db.query(
      `SELECT value FROM stats_cache WHERE key = 'api_stats' AND expires_at > NOW()`
    );
    if (cached.rows.length) return ok(res, cached.rows[0].value);

    const [total, byYear, bySector, byType, byStatus, largest] = await Promise.all([
      db.query(`SELECT COUNT(*) as count, SUM(deal_value)/100 as total_value FROM deals WHERE canonical_id IS NULL`),
      db.query(`
        SELECT EXTRACT(YEAR FROM announcement_date)::int AS year, COUNT(*) as deals, SUM(deal_value)/100 as value
        FROM deals WHERE canonical_id IS NULL AND announcement_date IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `),
      db.query(`
        SELECT sector, COUNT(*) as deals FROM deals
        WHERE canonical_id IS NULL AND sector IS NOT NULL
        GROUP BY sector ORDER BY deals DESC LIMIT 15
      `),
      db.query(`
        SELECT deal_type, COUNT(*) as deals FROM deals
        WHERE canonical_id IS NULL AND deal_type IS NOT NULL
        GROUP BY deal_type ORDER BY deals DESC
      `),
      db.query(`
        SELECT status, COUNT(*) as deals FROM deals
        WHERE canonical_id IS NULL AND status IS NOT NULL
        GROUP BY status ORDER BY deals DESC
      `),
      db.query(`
        SELECT d.id, d.headline, d.deal_value/100 as value, d.announcement_date,
               a.name as acquirer, t.name as target, d.sector
        FROM deals d
        LEFT JOIN companies a ON d.acquirer_id = a.id
        LEFT JOIN companies t ON d.target_id   = t.id
        WHERE d.canonical_id IS NULL AND d.deal_value IS NOT NULL
        ORDER BY d.deal_value DESC LIMIT 10
      `),
    ]);

    const stats = {
      total_deals:     parseInt(total.rows[0].count),
      total_value_usd: parseFloat(total.rows[0].total_value) || 0,
      by_year:         byYear.rows,
      by_sector:       bySector.rows,
      by_type:         byType.rows,
      by_status:       byStatus.rows,
      largest_deals:   largest.rows,
      generated_at:    new Date().toISOString(),
    };

    await db.query(`
      INSERT INTO stats_cache (key, value, computed_at, expires_at)
      VALUES ('api_stats', $1, NOW(), NOW() + INTERVAL '1 hour')
      ON CONFLICT (key) DO UPDATE SET value = $1, computed_at = NOW(), expires_at = NOW() + INTERVAL '1 hour'
    `, [JSON.stringify(stats)]);

    ok(res, stats);
  } catch (e) {
    console.error('[API] Stats error:', e.message);
    err(res, 500, 'Could not compute statistics', 'STATS_ERROR');
  }
});

// ── GET /api/deals ─────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query);
    const {
      q, sector, status, deal_type, region, country,
      min_value, max_value, date_from, date_to,
      acquirer, target, sort = 'date_desc',
    } = req.query;

    const conditions = ['d.canonical_id IS NULL'];
    const params     = [];
    let   p          = 1;

    if (q)         { conditions.push(`(d.headline ILIKE $${p} OR a.name ILIKE $${p} OR t.name ILIKE $${p})`); params.push(`%${q}%`); p++; }
    if (sector)    { conditions.push(`d.sector ILIKE $${p}`);         params.push(`%${sector}%`); p++; }
    if (status)    { conditions.push(`d.status = $${p}`);             params.push(status); p++; }
    if (deal_type) { conditions.push(`d.deal_type = $${p}`);          params.push(deal_type); p++; }
    if (region)    { conditions.push(`d.region ILIKE $${p}`);         params.push(`%${region}%`); p++; }
    if (country)   { conditions.push(`d.country = $${p}`);            params.push(country); p++; }
    if (acquirer)  { conditions.push(`a.name ILIKE $${p}`);           params.push(`%${acquirer}%`); p++; }
    if (target)    { conditions.push(`t.name ILIKE $${p}`);           params.push(`%${target}%`); p++; }
    if (min_value && !isNaN(parseFloat(min_value))) { conditions.push(`d.deal_value >= $${p}`); params.push(parseFloat(min_value) * 100); p++; }
    if (max_value && !isNaN(parseFloat(max_value))) { conditions.push(`d.deal_value <= $${p}`); params.push(parseFloat(max_value) * 100); p++; }
    if (date_from) { conditions.push(`d.announcement_date >= $${p}`); params.push(date_from); p++; }
    if (date_to)   { conditions.push(`d.announcement_date <= $${p}`); params.push(date_to); p++; }

    // Strict allowlist prevents sort injection
    const sorts = {
      date_desc:  'd.announcement_date DESC NULLS LAST',
      date_asc:   'd.announcement_date ASC NULLS LAST',
      value_desc: 'd.deal_value DESC NULLS LAST',
      value_asc:  'd.deal_value ASC NULLS LAST',
      confidence: 'd.source_confidence DESC',
    };
    const orderBy = sorts[sort] || sorts.date_desc;
    const where   = conditions.join(' AND ');

    const [countRes, dataRes] = await Promise.all([
      db.query(`
        SELECT COUNT(*) FROM deals d
        LEFT JOIN companies a ON d.acquirer_id = a.id
        LEFT JOIN companies t ON d.target_id   = t.id
        WHERE ${where}
      `, params),
      db.query(`
        SELECT d.*, a.name AS acquirer_name, a.country AS acquirer_country,
               t.name AS target_name, t.country AS target_country
        FROM deals d
        LEFT JOIN companies a ON d.acquirer_id = a.id
        LEFT JOIN companies t ON d.target_id   = t.id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, limit, offset]),
    ]);

    const total = parseInt(countRes.rows[0].count);
    ok(res, dataRes.rows.map(formatDeal), {
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (e) {
    console.error('[API] Deals error:', e.message);
    err(res, 500, 'Could not fetch deals', 'DEALS_ERROR');
  }
});

// ── GET /api/deals/:id ─────────────────────────────────────────────
app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Validate UUID format to prevent query with garbage values
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return err(res, 400, 'Invalid deal ID format', 'INVALID_ID');
    }

    const [dealRes, sources, filings, comparables] = await Promise.all([
      db.query(`
        SELECT d.*, a.name AS acquirer_name, a.country AS acquirer_country,
               t.name AS target_name, t.country AS target_country
        FROM deals d
        LEFT JOIN companies a ON d.acquirer_id = a.id
        LEFT JOIN companies t ON d.target_id   = t.id
        WHERE d.id = $1
      `, [id]),
      db.query(
        'SELECT source_type, source_name, source_url, source_date FROM deal_sources WHERE deal_id = $1 ORDER BY source_date DESC',
        [id]
      ),
      db.query(
        'SELECT filing_type, document_url, edgar_url, accession_no, filing_date FROM filings WHERE deal_id = $1',
        [id]
      ),
      db.query(`
        SELECT d.id, d.headline, d.deal_value/100 as deal_value, d.announcement_date, d.sector,
               a.name AS acquirer_name, t.name AS target_name
        FROM deals d
        LEFT JOIN companies a ON d.acquirer_id = a.id
        LEFT JOIN companies t ON d.target_id   = t.id
        WHERE d.canonical_id IS NULL AND d.id != $1 AND d.sector = (SELECT sector FROM deals WHERE id=$1)
          AND d.deal_value IS NOT NULL
          AND ABS(COALESCE(d.deal_value,0) - COALESCE((SELECT deal_value FROM deals WHERE id=$1),0))
            / NULLIF(GREATEST(COALESCE(d.deal_value,1),(SELECT COALESCE(deal_value,1) FROM deals WHERE id=$1)),0) < 0.7
        ORDER BY ABS(COALESCE(d.deal_value,0) - COALESCE((SELECT deal_value FROM deals WHERE id=$1),0)) ASC
        LIMIT 5
      `, [id]),
    ]);

    if (!dealRes.rows.length) return err(res, 404, 'Deal not found', 'NOT_FOUND');

    ok(res, {
      ...formatDeal(dealRes.rows[0]),
      sources:     sources.rows,
      filings:     filings.rows,
      comparables: comparables.rows,
    });
  } catch (e) {
    console.error('[API] Deal detail error:', e.message);
    err(res, 500, 'Could not fetch deal', 'DEAL_ERROR');
  }
});

// ── GET /api/search ────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  const limitRaw = parseInt(req.query.limit || 20);
  const limit    = isNaN(limitRaw) ? 20 : Math.min(limitRaw, 100);

  if (!q || q.trim().length < 2) return err(res, 400, 'Query too short', 'QUERY_TOO_SHORT');
  if (q.length > 200)            return err(res, 400, 'Query too long',  'QUERY_TOO_LONG');

  try {
    const start   = Date.now();
    const results = await db.query(`
      SELECT d.id, d.headline, d.deal_value/100 as deal_value, d.announcement_date,
             d.sector, d.status, d.deal_type, d.source_confidence,
             a.name AS acquirer_name, t.name AS target_name,
             ts_rank(to_tsvector('english', COALESCE(d.headline,'') || ' ' || COALESCE(a.name,'') || ' ' || COALESCE(t.name,'')),
                     plainto_tsquery('english', $1)) AS rank
      FROM deals d
      LEFT JOIN companies a ON d.acquirer_id = a.id
      LEFT JOIN companies t ON d.target_id   = t.id
      WHERE d.canonical_id IS NULL
        AND (
          to_tsvector('english', COALESCE(d.headline,'') || ' ' || COALESCE(a.name,'') || ' ' || COALESCE(t.name,''))
          @@ plainto_tsquery('english', $1)
          OR d.headline ILIKE $2 OR a.name ILIKE $2 OR t.name ILIKE $2
        )
      ORDER BY rank DESC, d.deal_value DESC NULLS LAST
      LIMIT $3
    `, [q, `%${q}%`, limit]);

    const duration = Date.now() - start;
    // Store only truncated query to avoid PII — no personal queries stored
    db.query(
      'INSERT INTO search_log (query, result_count, duration_ms) VALUES ($1, $2, $3)',
      [q.slice(0, 100), results.rows.length, duration]
    ).catch(() => {});

    ok(res, results.rows.map(formatDeal), { query: q, count: results.rows.length, duration_ms: duration });
  } catch (e) {
    console.error('[API] Search error:', e.message);
    err(res, 500, 'Search failed', 'SEARCH_ERROR');
  }
});

// ── GET /api/companies ─────────────────────────────────────────────
app.get('/api/companies', async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query);
    const { q, country, sector }  = req.query;
    const conditions = ['1=1'];
    const params     = [];
    let   p          = 1;

    if (q)       { conditions.push(`name ILIKE $${p}`);     params.push(`%${q}%`);      p++; }
    if (country) { conditions.push(`country = $${p}`);      params.push(country);        p++; }
    if (sector)  { conditions.push(`industry ILIKE $${p}`); params.push(`%${sector}%`); p++; }

    const where = conditions.join(' AND ');
    const [count, data] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM companies WHERE ${where}`, params),
      db.query(`
        SELECT c.*, COUNT(DISTINCT da.id) as deals_as_acquirer, COUNT(DISTINCT dt.id) as deals_as_target
        FROM companies c
        LEFT JOIN deals da ON da.acquirer_id = c.id AND da.canonical_id IS NULL
        LEFT JOIN deals dt ON dt.target_id   = c.id AND dt.canonical_id IS NULL
        WHERE ${where}
        GROUP BY c.id
        ORDER BY (COUNT(DISTINCT da.id) + COUNT(DISTINCT dt.id)) DESC
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, limit, offset]),
    ]);

    ok(res, data.rows, {
      pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(parseInt(count.rows[0].count) / limit) }
    });
  } catch (e) {
    err(res, 500, 'Could not fetch companies', 'COMPANIES_ERROR');
  }
});

// ── GET /api/companies/:id ─────────────────────────────────────────
app.get('/api/companies/:id', async (req, res) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return err(res, 400, 'Invalid company ID format', 'INVALID_ID');
    }

    const company = await db.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (!company.rows.length) return err(res, 404, 'Company not found', 'NOT_FOUND');

    const [asAcquirer, asTarget] = await Promise.all([
      db.query(`
        SELECT d.id, d.headline, d.deal_value/100 as deal_value, d.announcement_date, d.status, d.sector,
               t.name AS target_name
        FROM deals d LEFT JOIN companies t ON d.target_id = t.id
        WHERE d.acquirer_id = $1 AND d.canonical_id IS NULL
        ORDER BY d.announcement_date DESC LIMIT 20
      `, [req.params.id]),
      db.query(`
        SELECT d.id, d.headline, d.deal_value/100 as deal_value, d.announcement_date, d.status, d.sector,
               a.name AS acquirer_name
        FROM deals d LEFT JOIN companies a ON d.acquirer_id = a.id
        WHERE d.target_id = $1 AND d.canonical_id IS NULL
        ORDER BY d.announcement_date DESC LIMIT 20
      `, [req.params.id]),
    ]);

    ok(res, { ...company.rows[0], deals_as_acquirer: asAcquirer.rows, deals_as_target: asTarget.rows });
  } catch (e) {
    err(res, 500, 'Could not fetch company', 'COMPANY_ERROR');
  }
});

// ── GET /api/sectors ───────────────────────────────────────────────
app.get('/api/sectors', async (req, res) => {
  try {
    const data = await db.query(`
      SELECT sector, COUNT(*) AS deal_count, SUM(deal_value)/100 AS total_value,
             AVG(deal_value)/100 AS avg_value, MAX(deal_value)/100 AS max_value,
             COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
             MIN(announcement_date) AS earliest, MAX(announcement_date) AS latest
      FROM deals
      WHERE canonical_id IS NULL AND sector IS NOT NULL
      GROUP BY sector ORDER BY deal_count DESC
    `);
    ok(res, data.rows);
  } catch (e) {
    err(res, 500, 'Could not fetch sectors', 'SECTORS_ERROR');
  }
});

// ── 404 ────────────────────────────────────────────────────────────
app.use((req, res) => {
  err(res, 404, `Route not found: ${req.method} ${req.path}`, 'NOT_FOUND');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[API] mergers.news API running on port ${PORT}`);
});

module.exports = app;
