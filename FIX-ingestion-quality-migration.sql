ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS extracted_acquirer_name TEXT,
  ADD COLUMN IF NOT EXISTS extracted_target_name TEXT,
  ADD COLUMN IF NOT EXISTS seller_name TEXT,
  ADD COLUMN IF NOT EXISTS raw_extracted_snippet TEXT;

UPDATE deals d
SET
  extracted_acquirer_name = CASE WHEN a.name !~* '^(unknown|undisclosed|acquirer.*see filing|disclosed in filing)$' THEN a.name END,
  extracted_target_name = CASE WHEN t.name !~* '^(unknown|undisclosed|target.*see filing|public company target.*see filing)$' THEN t.name END
FROM companies a, companies t
WHERE d.acquirer_id = a.id
  AND d.target_id = t.id
  AND (d.extracted_acquirer_name IS NULL OR d.extracted_target_name IS NULL);

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_acquirer_or_review;
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_target_or_review;
ALTER TABLE deals ADD CONSTRAINT deals_acquirer_or_review CHECK (
  acquirer_id IS NOT NULL OR (needs_review = true AND source_confidence <= 0.70)
) NOT VALID;
ALTER TABLE deals ADD CONSTRAINT deals_target_or_review CHECK (
  target_id IS NOT NULL OR (needs_review = true AND source_confidence <= 0.70)
) NOT VALID;

DELETE FROM deal_sources newer
USING deal_sources older
WHERE newer.source_url IS NOT NULL
  AND newer.source_url = older.source_url
  AND (
    newer.created_at > older.created_at
    OR (newer.created_at = older.created_at AND newer.id::text > older.id::text)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_url_unique
  ON deal_sources(source_url) WHERE source_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingestion_raw_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type VARCHAR(50) NOT NULL,
  source_url TEXT NOT NULL,
  source_date DATE,
  raw_content TEXT,
  processing_status VARCHAR(30) DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_sources_url ON ingestion_raw_sources(source_url);

UPDATE deals d
SET acquirer_id = NULL, needs_review = true, source_confidence = LEAST(source_confidence, 0.45)
FROM companies c
WHERE d.acquirer_id = c.id AND c.name ~* 'see filing|^(unknown|undisclosed)$';

UPDATE deals d
SET target_id = NULL, needs_review = true, source_confidence = LEAST(source_confidence, 0.45)
FROM companies c
WHERE d.target_id = c.id AND c.name ~* 'see filing|^(unknown|undisclosed)$';
