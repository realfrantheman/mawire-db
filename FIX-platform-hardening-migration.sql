-- mergers.news production hardening migration — 2026-09-01
-- Additive/idempotent except for rebuilding the unused deals_full convenience view.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS review_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_last_error TEXT;

-- Historical APAC ingestors incorrectly stored a region label in sector.
UPDATE deals d
SET sector = NULL,
    region = COALESCE(NULLIF(d.region, ''), 'APAC'),
    country = COALESCE(NULLIF(d.country, ''), CASE ds.source_type
      WHEN 'hkex' THEN 'HK'
      WHEN 'asx' THEN 'AU'
      WHEN 'sgx' THEN 'SG'
      ELSE d.country
    END)
FROM LATERAL (
  SELECT source_type
  FROM deal_sources s
  WHERE s.deal_id = d.id AND s.source_type IN ('hkex', 'asx', 'sgx')
  ORDER BY s.created_at ASC
  LIMIT 1
) ds
WHERE d.sector = 'Asia Pacific';

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
