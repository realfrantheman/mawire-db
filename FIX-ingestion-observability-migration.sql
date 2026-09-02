-- Two-stage ingestion telemetry and recoverable near-miss state.
-- Idempotent and backward compatible with the 2026-06-11 quality migration.

ALTER TABLE ingestion_log
  ADD COLUMN IF NOT EXISTS candidates INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_enriched INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_publishable INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_published INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_duplicate INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_review INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_rejected INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_by_filter INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_by_quality_gate INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata_fetches INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS full_text_fetches INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS network_ms BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms BIGINT,
  ADD COLUMN IF NOT EXISTS rejection_reasons JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resource_usage JSONB DEFAULT '{}'::jsonb;

ALTER TABLE ingestion_raw_sources
  ADD COLUMN IF NOT EXISTS source_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS source_identity VARCHAR(128),
  ADD COLUMN IF NOT EXISTS canonical_url TEXT,
  ADD COLUMN IF NOT EXISTS raw_title TEXT,
  ADD COLUMN IF NOT EXISTS raw_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS parser_version VARCHAR(100),
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS review_labels TEXT[],
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fetch_status VARCHAR(30) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS http_status INTEGER,
  ADD COLUMN IF NOT EXISTS body_prefix TEXT,
  ADD COLUMN IF NOT EXISTS extraction_attempts JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_sources_identity
  ON ingestion_raw_sources(source_identity) WHERE source_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_sources_recovery
  ON ingestion_raw_sources(processing_status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_raw_sources_rejection
  ON ingestion_raw_sources(source_type, rejection_reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_log_source_started
  ON ingestion_log(source, run_started_at DESC);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS extraction_version VARCHAR(100),
  ADD COLUMN IF NOT EXISTS confidence_components JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS review_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS review_labels TEXT[],
  ADD COLUMN IF NOT EXISTS evidence_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_deals_review_reason
  ON deals(review_reason, updated_at DESC) WHERE needs_review = true;
CREATE INDEX IF NOT EXISTS idx_deals_evidence_hash
  ON deals(evidence_hash) WHERE evidence_hash IS NOT NULL;

CREATE OR REPLACE VIEW ingestion_source_baseline AS
SELECT
  source,
  COALESCE(SUM(records_fetched), 0)::bigint AS fetched_count,
  COALESCE(SUM(candidates), 0)::bigint AS candidate_count,
  COALESCE(SUM(records_new), 0)::bigint AS inserted_count,
  COALESCE(SUM(records_enriched), 0)::bigint AS enriched_count,
  COALESCE(SUM(records_publishable), 0)::bigint AS publishable_count,
  COALESCE(SUM(records_published), 0)::bigint AS published_count,
  COALESCE(SUM(records_duplicate), 0)::bigint AS duplicate_count,
  COALESCE(SUM(records_review), 0)::bigint AS review_count,
  COALESCE(SUM(records_failed), 0)::bigint AS failure_count,
  ROUND(AVG(NULLIF(network_ms, 0))::numeric, 1) AS average_fetch_time_ms,
  COALESCE(SUM(retry_count), 0)::bigint AS retry_count,
  COALESCE(SUM(skipped_by_filter), 0)::bigint AS skipped_by_filter_count,
  COALESCE(SUM(skipped_by_quality_gate), 0)::bigint AS skipped_by_quality_gate_count,
  jsonb_strip_nulls(jsonb_build_object(
    'reasons', jsonb_agg(rejection_reasons) FILTER (WHERE rejection_reasons <> '{}'::jsonb)
  )) AS top_rejection_reasons
FROM ingestion_log
WHERE run_started_at >= NOW() - INTERVAL '30 days'
GROUP BY source;

CREATE OR REPLACE VIEW ingestion_review_queue AS
SELECT
  COALESCE(review_reason, 'unclassified') AS review_reason,
  COUNT(*) AS deal_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::numeric, 1) AS average_age_days,
  MAX(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::int AS oldest_age_days
FROM deals
WHERE canonical_id IS NULL AND needs_review = true
GROUP BY COALESCE(review_reason, 'unclassified');
