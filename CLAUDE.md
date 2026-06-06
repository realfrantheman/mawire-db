# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

`mawire-db` is a **data-only repository** — a versioned JSON database of M&A (mergers and acquisitions) transactions. There is no application code, build system, or test suite. The entire dataset lives in a single file: `deals.json`.

Updates happen as full-file replacements committed to `main`. Commit messages follow the pattern: `Enriched backfill: N deals with values + descriptions`.

## deals.json Schema

Each record in the top-level JSON array has these 23 fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique deal identifier (see ID conventions below) |
| `headline` | string | Brief deal title |
| `subheadline` | string | Additional context line |
| `acquirer` | string | Acquiring entity; `"Disclosed in filing"` if not parsed |
| `target` | string | Target entity; `"Public company target (see filing)"` for some SEC records |
| `dealValue` | string | Human-readable value (e.g., `"$35.3B"`, `"Undisclosed"`) |
| `dealValueNum` | number | Value in **millions USD**; `0` means undisclosed |
| `dealType` | string | One of: `Acquisition`, `Merger`, `Divestiture`, `Funding Round`, `Strategic Investment` |
| `sector` | string | One of 10 sectors (see below) |
| `region` | string | One of: `North America`, `Europe`, `Asia-Pacific`, `Middle East`, `Global` |
| `year` | number | Transaction year |
| `era` | string | One of: `historic` (pre-2000s), `2000s`, `2010s`, `2020s` |
| `dateISO` | string | ISO 8601 date (`YYYY-MM-DD`) |
| `date` | string | Human-readable date (e.g., `"Jun 5, 2026"`) |
| `timeAgo` | string | Relative label (e.g., `"Today"`, `"3 days ago"`) — stale after commit |
| `body` | string | Multi-paragraph deal description |
| `source` | string | One of 8 sources (see below) |
| `sourceUrl` | string | Direct URL to source document |
| `advisors` | array | Financial/legal advisor names; empty array for most records (~48 deals have data) |
| `status` | string | One of: `Announced`, `Completed`, `Pending Regulatory` |
| `premium` | number\|null | Acquisition premium percentage, or `null` |
| `breaking` | boolean | Breaking news flag; currently `false` for all records |

**Sectors:** Consumer, Energy, Financial Services, Healthcare, Industrials, Media, Other, Real Estate, Technology, Telecommunications

**Sources:** SEC Filing, Bloomberg, Reuters, WSJ, Company Press Release, BusinessWire, GlobeNewswire, PRNewswire

## ID Conventions

IDs are kebab-case slugs with a source-type prefix and a date suffix:

- **SEC DEFM14A filings:** `defm-{company-slug}-{ticker}-{YYYY-MM-DD}` (e.g., `defm-trubridge-inc-tbrg-2026-06-04`)
- **SEC SC TO-T tender offers:** `scto-{company-slug}-{YYYY-MM-DD}` (e.g., `scto-genco-shipping-trading-2026-06-04`)
- **SEC S-4 filings:** `s4-{company-slug}-{YYYY-MM-DD}`
- **Historic/manual deals:** `{company-slug}-{YYYY-MM-DD}` (e.g., `aol-time-warner-2000-01-10`, `kkr-rjr-nabisco-1989-02-09`)

IDs are unique and stable — do not modify existing IDs.

## Data Sources and Characteristics

**SEC Filings (EDGAR)** — majority of records (~10,400 deals):
- Sourced from DEFM14A (definitive merger proxy), SC TO-T (tender offer), and S-4 (registration/merger) forms
- `acquirer` or `target` may be `"Disclosed in filing"` / `"Public company target (see filing)"` when not extractable from the form title
- `dealValue` can be a per-share price rather than total deal value (common in tender offers)

**Manual/curated entries** (~60 historic deals):
- High-profile deals added manually: AOL-Time Warner, Exxon-Mobil, Vodafone-Mannesmann, KKR-RJR Nabisco, etc.
- These have richer `body`, populated `advisors`, accurate `acquirer`/`target`, and correct `dealValueNum`

## Known Data Quality Considerations

- **`dealValueNum` for SEC filings is sometimes inflated** — the parser occasionally reads per-share price as total deal value, producing absurdly large numbers (e.g., `974700` for a $974.7 per-share offer). Do not rely on `dealValueNum` alone for filtering by deal size without sanity-checking against `dealValue`.
- **`timeAgo` is stale** after a commit — it reflects the time of data generation, not the current date.
- **~52% of deals have `dealValueNum: 0`** (undisclosed value).
- **`advisors` is sparsely populated** — only ~48 records have advisor data; absence does not mean no advisors were involved.

## Working with the Data

To query or validate the dataset locally, Python is the simplest tool:

```bash
# Count records
python3 -c "import json; d=json.load(open('deals.json')); print(len(d))"

# Filter by sector and region
python3 -c "
import json
deals = json.load(open('deals.json'))
subset = [d for d in deals if d['sector']=='Technology' and d['region']=='Europe']
print(len(subset), 'deals')
"

# Find duplicates by ID
python3 -c "
import json
deals = json.load(open('deals.json'))
ids = [d['id'] for d in deals]
dupes = [i for i in ids if ids.count(i) > 1]
print('Duplicate IDs:', set(dupes))
"
```

## Adding or Updating Deals

When modifying `deals.json`:
1. Preserve the array order (newest deals first).
2. All required fields must be present; use `null` for `premium`, `0` for `dealValueNum` when unknown, and `[]` for `advisors`.
3. `dealValueNum` is in **millions USD** — a $1B deal = `1000`, a $35.3B deal = `35300`.
4. Keep `era` consistent with `year`: pre-2000 → `"historic"`, 2000–2009 → `"2000s"`, 2010–2019 → `"2010s"`, 2020+ → `"2020s"`.
5. Validate JSON before committing: `python3 -c "import json; json.load(open('deals.json')); print('valid')"`.
