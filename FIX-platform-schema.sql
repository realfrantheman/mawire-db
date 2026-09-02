-- ═══════════════════════════════════════════════════════════════
-- mergers.news Data Platform — PostgreSQL Schema
-- PostgreSQL 15+
-- Financial convention: deals.deal_value is always USD cents.
-- Country convention: ISO 3166-1 alpha-2.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ── COMPANIES ────────────────────────────────────────────────────
CREATE TABLE companies (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  normalized_name     TEXT NOT NULL,
  aliases             TEXT[],
  ticker              VARCHAR(20),
  isin                VARCHAR(20),
  lei                 VARCHAR(20),
  country             CHAR(2),
  state               VARCHAR(100),
  industry            VARCHAR(100),
  sic_code            VARCHAR(10),
  website             TEXT,
  cik                 VARCHAR(20),
  opencorporates_id   TEXT,
  wikidata_id         TEXT,
  is_public           BOOLEAN DEFAULT false,
  exchange            VARCHAR(50),
  market_cap          BIGINT,
  employees           INTEGER,
  founded_year        INTEGER,
  description         TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_companies_cik ON companies(cik) WHERE cik IS NOT NULL;
CREATE INDEX idx_companies_normalized ON companies(normalized_name);
CREATE INDEX idx_companies_normalized_country ON companies(normalized_name, country, id);
CREATE INDEX idx_companies_name_trgm ON companies USING gin(name gin_trgm_ops);
CREATE INDEX idx_companies_ticker ON companies(ticker) WHERE ticker IS NOT NULL;

-- ── DEALS ────────────────────────────────────────────────────────
CREATE TABLE deals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  acquirer_id         UUID REFERENCES companies(id),
  target_id           UUID REFERENCES companies(id),

  headline            TEXT NOT NULL,
  deal_type           VARCHAR(50),
  status              VARCHAR(50),
  sub_status          VARCHAR(100),

  announcement_date   DATE,
  filing_date         DATE,
  expected_close_date DATE,
  close_date          DATE,

  deal_value          BIGINT,                 -- USD cents
  deal_value_original NUMERIC(20,2),
  currency            CHAR(3) DEFAULT 'USD',
  per_share_value     NUMERIC(10,4),
  premium_pct         NUMERIC(7,4),           -- percentage points, e.g. 25.5 = 25.5%
  ev_revenue          NUMERIC(10,4),
  ev_ebitda           NUMERIC(10,4),

  country             CHAR(2),
  region              VARCHAR(50),
  is_cross_border     BOOLEAN DEFAULT false,

  sector              VARCHAR(100),
  sub_sector          VARCHAR(100),
  is_private_equity   BOOLEAN DEFAULT false,
  is_hostile          BOOLEAN DEFAULT false,
  is_strategic        BOOLEAN DEFAULT false,
  tags                TEXT[],

  ai_summary          TEXT,
  extracted_acquirer_name TEXT,
  extracted_target_name   TEXT,
  seller_name         TEXT,
  raw_extracted_snippet TEXT,
  source_confidence   NUMERIC(5,4) DEFAULT 0,
  extraction_method   VARCHAR(50),
  needs_review        BOOLEAN DEFAULT false,

  canonical_id        UUID,
  duplicate_count     INTEGER DEFAULT 0,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT deals_acquirer_or_review CHECK (
    acquirer_id IS NOT NULL OR (needs_review = true AND source_confidence <= 0.70)
  ),
  CONSTRAINT deals_target_or_review CHECK (
    target_id IS NOT NULL OR (needs_review = true AND source_confidence <= 0.70)
  )
);

CREATE INDEX idx_deals_acquirer ON deals(acquirer_id);
CREATE INDEX idx_deals_target ON deals(target_id);
CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_deals_type ON deals(deal_type);
CREATE INDEX idx_deals_sector ON deals(sector);
CREATE INDEX idx_deals_announce ON deals(announcement_date DESC, id);
CREATE INDEX idx_deals_value ON deals(deal_value DESC, id);
CREATE INDEX idx_deals_country ON deals(country);
CREATE INDEX idx_deals_region ON deals(region);
CREATE INDEX idx_deals_canonical ON deals(canonical_id) WHERE canonical_id IS NOT NULL;
CREATE INDEX idx_deals_headline_trgm ON deals USING gin(headline gin_trgm_ops);
CREATE INDEX idx_deals_party_announcement ON deals(acquirer_id, target_id, announcement_date DESC, id) WHERE canonical_id IS NULL;
CREATE INDEX idx_deals_public_announcement ON deals(announcement_date DESC, id) WHERE canonical_id IS NULL AND needs_review = false;
CREATE INDEX idx_deals_public_value ON deals(deal_value DESC, id) WHERE canonical_id IS NULL AND needs_review = false;

-- ── DEAL SOURCES ─────────────────────────────────────────────────
CREATE TABLE deal_sources (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  source_type   VARCHAR(50) NOT NULL,
  source_name   VARCHAR(200),
  source_url    TEXT,
  source_date   DATE,
  raw_content   TEXT,
  confidence    NUMERIC(5,4),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sources_deal ON deal_sources(deal_id);
CREATE INDEX idx_sources_type ON deal_sources(source_type);
CREATE INDEX idx_sources_best_for_deal ON deal_sources(deal_id, confidence DESC, source_date DESC, created_at DESC, id);

CREATE TABLE ingestion_raw_sources (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type   VARCHAR(50) NOT NULL,
  source_url    TEXT NOT NULL,
  source_date   DATE,
  raw_content   TEXT,
  processing_status VARCHAR(30) DEFAULT 'pending',
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_raw_sources_url ON ingestion_raw_sources(source_url);

-- ── FILINGS ──────────────────────────────────────────────────────
CREATE TABLE filings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id       UUID REFERENCES deals(id) ON DELETE CASCADE,
  company_id    UUID REFERENCES companies(id),
  filing_type   VARCHAR(50) NOT NULL,
  document_url  TEXT,
  edgar_url     TEXT,
  accession_no  VARCHAR(50),
  cik           VARCHAR(20),
  filing_date   DATE,
  period_date   DATE,
  pages         INTEGER,
  raw_text_url  TEXT,
  processed     BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_filings_deal ON filings(deal_id);
CREATE INDEX idx_filings_type ON filings(filing_type);
CREATE INDEX idx_filings_date ON filings(filing_date DESC);
CREATE INDEX idx_filings_cik ON filings(cik);
CREATE INDEX idx_filings_best_for_deal ON filings(deal_id, filing_date DESC, created_at DESC, id);

-- ── ENTITY MATCHES ───────────────────────────────────────────────
CREATE TABLE entity_matches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  raw_name        TEXT NOT NULL,
  company_id      UUID REFERENCES companies(id),
  match_score     NUMERIC(5,4),
  match_method    VARCHAR(50),
  confirmed       BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_entity_raw ON entity_matches(raw_name);
CREATE INDEX idx_entity_company ON entity_matches(company_id);

-- ── INGESTION LOG ────────────────────────────────────────────────
CREATE TABLE ingestion_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          VARCHAR(50) NOT NULL,
  run_started_at  TIMESTAMPTZ NOT NULL,
  run_ended_at    TIMESTAMPTZ,
  records_fetched INTEGER DEFAULT 0,
  records_new     INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_failed  INTEGER DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'running',
  error_message   TEXT,
  metadata        JSONB
);
CREATE INDEX idx_log_source ON ingestion_log(source);
CREATE INDEX idx_log_started ON ingestion_log(run_started_at DESC);
CREATE INDEX idx_ingestion_log_health ON ingestion_log(source, status, run_started_at DESC);

-- ── STATISTICS CACHE ─────────────────────────────────────────────
CREATE TABLE stats_cache (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  computed_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);

-- ── SEARCH LOG ───────────────────────────────────────────────────
CREATE TABLE search_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  query         TEXT,
  filters       JSONB,
  result_count  INTEGER,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── TRIGGERS ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER deals_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── VIEWS ────────────────────────────────────────────────────────
CREATE VIEW deals_full AS
SELECT
  d.*,
  a.name AS acquirer_name,
  a.country AS acquirer_country,
  t.name AS target_name,
  t.country AS target_country,
  (d.deal_value::double precision / 100000000000.0) AS deal_value_b
FROM deals d
LEFT JOIN companies a ON d.acquirer_id = a.id
LEFT JOIN companies t ON d.target_id = t.id
WHERE d.canonical_id IS NULL;

CREATE VIEW deal_stats AS
SELECT
  EXTRACT(YEAR FROM announcement_date) AS year,
  sector,
  region,
  deal_type,
  status,
  COUNT(*) AS deal_count,
  SUM(deal_value) AS total_value,
  AVG(deal_value) AS avg_value,
  MAX(deal_value) AS max_value
FROM deals
WHERE canonical_id IS NULL
GROUP BY 1,2,3,4,5;
