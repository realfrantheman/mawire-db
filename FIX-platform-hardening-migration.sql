-- mergers.news production hardening migration — 2026-09-01
-- Additive/idempotent except for rebuilding the unused deals_full convenience view.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS review_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_last_error TEXT;

-- The API and exporter both depend on this publication-review state. The
-- verifier also creates it defensively, but schema ownership belongs here.
CREATE TABLE IF NOT EXISTS deal_transaction_reviews (
  deal_id UUID PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  transaction_type VARCHAR(80),
  reason_code VARCHAR(120) NOT NULL,
  rule_version VARCHAR(40) NOT NULL,
  evidence_url TEXT,
  evidence_excerpt TEXT,
  evidence_hash VARCHAR(64),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_deal_transaction_reviews_status
  ON deal_transaction_reviews(status, rule_version, reviewed_at DESC);

-- Historical APAC ingestors incorrectly stored a region label in sector.
UPDATE deals d
SET sector = NULL,
    region = COALESCE(NULLIF(d.region, ''), 'APAC'),
    country = COALESCE(NULLIF(d.country, ''), CASE
      WHEN EXISTS (SELECT 1 FROM deal_sources s WHERE s.deal_id=d.id AND s.source_type='hkex') THEN 'HK'
      WHEN EXISTS (SELECT 1 FROM deal_sources s WHERE s.deal_id=d.id AND s.source_type='asx') THEN 'AU'
      WHEN EXISTS (SELECT 1 FROM deal_sources s WHERE s.deal_id=d.id AND s.source_type='sgx') THEN 'SG'
      ELSE d.country
    END)
WHERE d.sector = 'Asia Pacific'
  AND EXISTS (SELECT 1 FROM deal_sources s WHERE s.deal_id=d.id AND s.source_type IN ('hkex','asx','sgx'));

-- Deterministic hot-path indexes used by deduplication, review, publication,
-- source selection, pagination, and ingestion health checks.
CREATE INDEX IF NOT EXISTS idx_deals_party_announcement
  ON deals(acquirer_id, target_id, announcement_date DESC, id)
  WHERE canonical_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_public_announcement
  ON deals(announcement_date DESC, id)
  WHERE canonical_id IS NULL AND needs_review = false;

CREATE INDEX IF NOT EXISTS idx_deals_public_value
  ON deals(deal_value DESC, id)
  WHERE canonical_id IS NULL AND needs_review = false;

CREATE INDEX IF NOT EXISTS idx_deals_review_retry
  ON deals(review_priority DESC, next_review_at, announcement_date DESC, id)
  WHERE canonical_id IS NULL AND needs_review = true;

CREATE INDEX IF NOT EXISTS idx_sources_best_for_deal
  ON deal_sources(deal_id, confidence DESC, source_date DESC, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_filings_best_for_deal
  ON filings(deal_id, filing_date DESC, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_ingestion_log_health
  ON ingestion_log(source, status, run_started_at DESC);

CREATE INDEX IF NOT EXISTS idx_companies_normalized_country
  ON companies(normalized_name, country, id);

-- Correct cents -> USD billions conversion. 100 cents/USD * 1e9 USD/billion = 1e11.
DROP VIEW IF EXISTS deals_full;
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
