-- Review-queue lifecycle and source-jurisdiction backfill.
-- Idempotent. Country values use ISO 3166-1 alpha-2 because deals.country is CHAR(2).

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(30) DEFAULT 'resolved',
  ADD COLUMN IF NOT EXISTS review_priority SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_review_at TIMESTAMPTZ;

UPDATE deals
SET review_status = CASE
      WHEN needs_review = false THEN 'resolved'
      WHEN source_confidence >= 0.75
        AND (acquirer_id IS NOT NULL OR target_id IS NOT NULL)
        AND COALESCE(raw_extracted_snippet, '') <> '' THEN 'pending'
      ELSE 'deferred'
    END,
    review_priority = CASE
      WHEN needs_review = false THEN 0
      WHEN source_confidence >= 0.75 THEN 90
      WHEN source_confidence >= 0.65 THEN 70
      WHEN source_confidence >= 0.50 THEN 40
      ELSE 20
    END,
    next_review_at = CASE
      WHEN needs_review = true AND source_confidence < 0.75
        THEN COALESCE(next_review_at, NOW() + INTERVAL '30 days')
      ELSE next_review_at
    END,
    status = CASE
      WHEN needs_review = true AND status IN ('Announced', 'Pending') THEN 'Under Review'
      ELSE status
    END
WHERE review_status IS NULL
   OR (needs_review = true AND review_status = 'resolved')
   OR (needs_review = false AND review_status <> 'resolved');

CREATE OR REPLACE FUNCTION normalize_deal_review_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.needs_review THEN
    IF TG_OP = 'INSERT'
       OR OLD.needs_review IS DISTINCT FROM NEW.needs_review
       OR NEW.review_status IS NULL
       OR NEW.review_status = 'resolved' THEN
      NEW.review_status := CASE
        WHEN COALESCE(NEW.source_confidence, 0) >= 0.75
          AND (NEW.acquirer_id IS NOT NULL OR NEW.target_id IS NOT NULL)
          AND COALESCE(NEW.raw_extracted_snippet, '') <> '' THEN 'pending'
        ELSE 'deferred'
      END;
    END IF;
    NEW.review_priority := CASE
      WHEN COALESCE(NEW.source_confidence, 0) >= 0.75 THEN 90
      WHEN COALESCE(NEW.source_confidence, 0) >= 0.65 THEN 70
      WHEN COALESCE(NEW.source_confidence, 0) >= 0.50 THEN 40
      ELSE 20
    END;
    IF NEW.status IN ('Announced', 'Pending') THEN NEW.status := 'Under Review'; END IF;
  ELSE
    NEW.review_status := 'resolved';
    NEW.review_priority := 0;
    NEW.next_review_at := NULL;
    IF NEW.status = 'Under Review' THEN NEW.status := 'Announced'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deals_review_lifecycle_insert ON deals;
CREATE TRIGGER deals_review_lifecycle_insert
BEFORE INSERT ON deals
FOR EACH ROW EXECUTE FUNCTION normalize_deal_review_lifecycle();

DROP TRIGGER IF EXISTS deals_review_lifecycle_update ON deals;
CREATE TRIGGER deals_review_lifecycle_update
BEFORE UPDATE OF needs_review, source_confidence, acquirer_id, target_id, raw_extracted_snippet, review_status
ON deals
FOR EACH ROW EXECUTE FUNCTION normalize_deal_review_lifecycle();

WITH source_jurisdiction AS (
  SELECT DISTINCT ON (deal_id) deal_id, source_type
  FROM deal_sources
  WHERE source_type IN ('eu_merger_registry', 'hkex', 'asx', 'sgx')
  ORDER BY deal_id, CASE source_type
    WHEN 'eu_merger_registry' THEN 0
    WHEN 'hkex' THEN 1
    WHEN 'asx' THEN 2
    WHEN 'sgx' THEN 3
    ELSE 9 END,
    created_at
)
UPDATE deals d
SET region = CASE
      WHEN ds.source_type = 'eu_merger_registry' THEN 'Europe'
      WHEN ds.source_type IN ('hkex', 'asx', 'sgx') THEN 'APAC'
      ELSE d.region
    END,
    country = CASE
      WHEN ds.source_type = 'hkex' THEN 'HK'
      WHEN ds.source_type = 'asx' THEN 'AU'
      WHEN ds.source_type = 'sgx' THEN 'SG'
      ELSE d.country
    END
FROM source_jurisdiction ds
WHERE d.canonical_id IS NULL
  AND ds.deal_id = d.id
  AND (d.region IS NULL OR d.region = '' OR d.country IS NULL OR d.country = '')
  AND ds.source_type IN ('eu_merger_registry', 'hkex', 'asx', 'sgx');

CREATE OR REPLACE FUNCTION apply_source_jurisdiction_to_deal()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type = 'eu_merger_registry' THEN
    UPDATE deals SET region = COALESCE(NULLIF(region, ''), 'Europe') WHERE id = NEW.deal_id;
  ELSIF NEW.source_type = 'hkex' THEN
    UPDATE deals SET region = COALESCE(NULLIF(region, ''), 'APAC'),
      country = COALESCE(NULLIF(country, ''), 'HK') WHERE id = NEW.deal_id;
  ELSIF NEW.source_type = 'asx' THEN
    UPDATE deals SET region = COALESCE(NULLIF(region, ''), 'APAC'),
      country = COALESCE(NULLIF(country, ''), 'AU') WHERE id = NEW.deal_id;
  ELSIF NEW.source_type = 'sgx' THEN
    UPDATE deals SET region = COALESCE(NULLIF(region, ''), 'APAC'),
      country = COALESCE(NULLIF(country, ''), 'SG') WHERE id = NEW.deal_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deal_sources_apply_jurisdiction ON deal_sources;
CREATE TRIGGER deal_sources_apply_jurisdiction
AFTER INSERT OR UPDATE OF source_type ON deal_sources
FOR EACH ROW EXECUTE FUNCTION apply_source_jurisdiction_to_deal();

CREATE INDEX IF NOT EXISTS idx_deals_actionable_review
  ON deals(review_priority DESC, next_review_at, updated_at)
  WHERE canonical_id IS NULL AND needs_review = true AND review_status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_deals_review_status
  ON deals(review_status, updated_at DESC)
  WHERE canonical_id IS NULL AND needs_review = true;

CREATE OR REPLACE VIEW ingestion_review_queue AS
SELECT
  COALESCE(review_reason, 'unclassified') AS review_reason,
  COUNT(*) AS deal_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::numeric, 1) AS average_age_days,
  MAX(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::int AS oldest_age_days,
  COALESCE(review_status, 'pending') AS review_status
FROM deals
WHERE canonical_id IS NULL AND needs_review = true
GROUP BY COALESCE(review_reason, 'unclassified'), COALESCE(review_status, 'pending');
