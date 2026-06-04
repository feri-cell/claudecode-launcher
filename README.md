# MSC EDGAR — Custom Enrichment System

Turns SEC EDGAR filings (Reg A+, Reg D, Reg S, Rule 144A) into usable outreach
records — clean company, real website, named decision-makers with roles, and
candidate/verified email addresses — using **only free, public SEC data**. The
Hunter.io replacement for the MSC Outreach dashboard.

Full specification: [`MSC_EDGAR_Enrichment_Brief.md`](./MSC_EDGAR_Enrichment_Brief.md).

## Pipeline (four layers)

1. **Discovery** — EFTS full-text search → accession + correct *issuer* CIK.
2. **Company enrichment** — `data.sec.gov/submissions` → clean name, real website, SIC, state.
3. **Officer extraction** — Form D XML + 1-A/S-1/F-series HTML → top-3 decision-makers.
4. **Email finding** — pattern generation + verification (MX/SMTP, optional paid API, site scrape).

Each layer is independently re-runnable and persists to SQLite, so a crash
resumes from the last checkpoint. Output is a CSV that loads directly into the
v7 outreach dashboard (column names locked in brief §6).

## Build status

| Phase | State |
|---|---|
| 0 — Scaffold (venv, schema, config, fixtures, tests) | ✅ done |
| 1 — Discovery (EFTS) | ✅ done |
| 2 — Company enrichment | ⬜ next |
| 3 — Officer extraction | ⬜ |
| 4 — Email finding | ⬜ |
| 5 — Orchestration, CSV export, schedule | ⬜ |

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m msc_edgar.db      # create data/edgar.sqlite3 with all tables
pytest -q                   # run the test suite
```

> Requires Python 3.12+ and outbound network access to `*.sec.gov` /
> `efts.sec.gov`. SEC requires a real contact email in the User-Agent — set in
> [`config.py`](./config.py) (`USER_AGENT`).

## Layout

```
config.py              # all tunables (UA, rate limit, forms, role priority, email patterns)
msc_edgar/
  schema.sql           # SQLite schema (companies, filings, officers, emails, + ops tables)
  db.py                # schema init + sync/async connections
tests/
  fixtures/            # known-good Form D XML, 1-A HTML, S-1 HTML for parser tests
data/                  # SQLite db + exported CSV (git-ignored, regenerated)
```

## Design constraints

- **No contact-data vendors** (Hunter, Apollo, ZoomInfo, RocketReach, Clearbit). Free SEC data only; the one optional paid dependency is an SMTP-verification API in Phase 4.
- **Issuer CIK comes from `_source.ciks[0]`**, never the accession number's first segment (that's the filer agent — the bug in the previous build).
- **Never fabricate websites.** Real URL from submissions JSON or blank.
- **SEC compliance:** real User-Agent, ≤10 req/s (we target 5), HTTPS only.
