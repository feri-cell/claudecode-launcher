-- MSC EDGAR enrichment — D1 (SQLite) schema.
-- Ported from the Python build's schema.sql, plus the cron-engine tables
-- (disco_windows, crawl_state) that make a multi-day backfill resumable.

-- Layer 2 output: one canonical row per issuer.
CREATE TABLE IF NOT EXISTS companies (
    cik              INTEGER PRIMARY KEY,
    name             TEXT,
    website          TEXT,
    website_source   TEXT DEFAULT 'unknown',   -- 'verified' | 'unknown'
    sic              TEXT,
    sic_description  TEXT,
    state            TEXT,
    status           TEXT,                      -- NULL = discovered, 'enriched' = Layer 2 done
    first_seen_at    TEXT,
    last_updated_at  TEXT
);

-- Layer 1 output: one row per filing.
CREATE TABLE IF NOT EXISTS filings (
    accession    TEXT PRIMARY KEY,
    cik          INTEGER NOT NULL,
    regulation   TEXT NOT NULL,                 -- 'A+' | 'D' | 'S' | '144A'
    form_type    TEXT NOT NULL,
    filing_date  TEXT NOT NULL,
    primary_doc  TEXT,
    status       TEXT DEFAULT 'filed',          -- filed|parsed|incomplete
    retry_count  INTEGER DEFAULT 0,
    last_error   TEXT,
    FOREIGN KEY (cik) REFERENCES companies(cik)
);
CREATE INDEX IF NOT EXISTS idx_filings_cik ON filings(cik);
CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
CREATE INDEX IF NOT EXISTS idx_filings_reg_date ON filings(regulation, filing_date);

-- Layer 3 output: extracted decision-makers.
CREATE TABLE IF NOT EXISTS officers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cik              INTEGER NOT NULL,
    full_name        TEXT,
    first            TEXT,
    last             TEXT,
    role             TEXT,
    role_priority    INTEGER DEFAULT 99,
    source_accession TEXT,
    source_type      TEXT,                      -- 'formd_xml' | 'html_1a' | 'html_sf'
    rank             INTEGER,
    is_top_3         INTEGER DEFAULT 0,
    FOREIGN KEY (cik) REFERENCES companies(cik)
);
CREATE INDEX IF NOT EXISTS idx_officers_cik ON officers(cik);
CREATE UNIQUE INDEX IF NOT EXISTS uq_officer_identity
    ON officers(cik, full_name, role);

-- Layer 4 (built later): candidate + verified addresses.
CREATE TABLE IF NOT EXISTS emails (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cik                 INTEGER NOT NULL,
    officer_id          INTEGER NOT NULL,
    address             TEXT NOT NULL,
    pattern             TEXT,
    verification_status TEXT DEFAULT 'not_attempted',
    response_code       TEXT,
    verified_at         TEXT,
    FOREIGN KEY (cik) REFERENCES companies(cik),
    FOREIGN KEY (officer_id) REFERENCES officers(id)
);
CREATE INDEX IF NOT EXISTS idx_emails_officer ON emails(officer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attempt ON emails(officer_id, address);

-- Cron engine: resumable EFTS discovery work queue. One row per date window.
-- A window over the 10k EFTS cap is split in two (bisection) and re-queued.
CREATE TABLE IF NOT EXISTS disco_windows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    regulation   TEXT NOT NULL,
    form_type    TEXT NOT NULL,
    start_date   TEXT NOT NULL,                 -- YYYY-MM-DD inclusive
    end_date     TEXT NOT NULL,                 -- YYYY-MM-DD inclusive
    from_offset  INTEGER DEFAULT 0,             -- EFTS paging cursor for resume
    total        INTEGER,                       -- last-seen hit count for this window
    status       TEXT DEFAULT 'pending',        -- pending | done | error
    attempts     INTEGER DEFAULT 0,             -- consecutive failed query attempts
    last_error   TEXT,
    UNIQUE(regulation, form_type, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_disco_status ON disco_windows(status);

-- Cron engine: small key/value state (active flag, selected regs, lease lock,
-- running totals snapshot for cheap progress reads).
CREATE TABLE IF NOT EXISTS crawl_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT
);

-- Observability: every outbound SEC request.
CREATE TABLE IF NOT EXISTS fetch_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    status_code  INTEGER,
    ok           INTEGER,
    duration_ms  INTEGER,
    error        TEXT,
    fetched_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fetch_log_time ON fetch_log(fetched_at);
