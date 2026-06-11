# Ingestion and Acquirer Audit

## Production baseline

Snapshot from the current `mawire-db/deals.json` before this change:

- Exported deals: 4,830
- Records containing a `see filing` placeholder in a party or headline: 4,612
- Records with an unresolved/placeholder acquirer: 1,561

The largest root cause was not frontend rendering. SEC ingestion and historical backfill
created `Acquirer (see filing)`, `Target (see filing)`, and `Unknown` as real company
records. Those entities then flowed through the database, API, export, and frontend.

## Sources improved

- SEC EDGAR: shared fallback party extraction, retries, raw evidence storage, nullable
  unresolved parties, correct filer-to-company association, and no placeholder entities.
- Historical SEC backfill: same extraction and placeholder protections as live SEC.
- News RSS: title plus description extraction, retries, raw evidence, and confidence based
  on extracted party completeness.
- APAC (HKEX, ASX, SGX): retries and source-specific title party extraction.
- EU Merger Registry and Companies House: retry/backoff at source boundaries.
- GDELT: retry/backoff, valid raw-source review storage, party evidence, and correct
  low-confidence review behavior.

## Data model and output

- Added raw extracted buyer/target text, seller, and evidence snippet fields.
- Added `ingestion_raw_sources` for failed/low-confidence sources that need reprocessing.
- Added validation requiring missing key parties to be explicitly low-confidence/reviewable.
- Added source URL deduplication.
- API/export/frontend now prefer linked normalized entities, then extracted party text.
- `Unknown acquirer` is displayed only after those paths are exhausted.

## Verification

- Shared extraction regression suite: 5/5 passing.
- Frontend duplicate-search and placeholder fallback suite: 2/2 passing.
- Syntax checks pass for every modified ingestor, API, export, backfill, and frontend file.
- Fixture extraction coverage improved from no shared fallback to successful extraction for
  direct acquisitions, acquired-by language, consortium buyers, and mergers of equals.

## Confidence and unresolved reporting

Run after migration and at least one ingestion cycle:

```sql
SELECT
  COUNT(*) FILTER (WHERE source_confidence >= 0.85) AS high,
  COUNT(*) FILTER (WHERE source_confidence >= 0.70 AND source_confidence < 0.85) AS medium,
  COUNT(*) FILTER (WHERE source_confidence < 0.70) AS low,
  COUNT(*) FILTER (WHERE needs_review) AS unresolved
FROM deals
WHERE canonical_id IS NULL;
```

## Remaining limitations

- Existing placeholder deals require the migration plus reprocessing/backfill before their
  real acquirers can be recovered; frontend safeguards prevent the placeholder from showing
  meanwhile.
- PDF/OCR extraction and paid/restricted news feeds are not included in this deployment.
- Exchange announcements with opaque titles remain low-confidence and are retained for review
  rather than assigned a fabricated buyer.
