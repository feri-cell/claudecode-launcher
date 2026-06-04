-- MSC EDGAR enrichment — SQLite schema (brief §7 Phase 0)
-- One source of truth for every table the four-layer pipeline writes to.
-- All timestamps are ISO-8601 UTC strings written by the application layer.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Layer 2 output: one canonical row per issuer.
CREATE TABLE IF NOT EXISTS companies (
    cik              INTEGER PRIMARY KEY,           -- issuer CIK, leading zeros stripped
    name             TEXT,                          -- clean name, no "(CIK ...)" suffix
    website          TEXT,                          -- real URL from submissions JSON, else NULL
    website_source   TEXT DEFAULT 'unknown',        -- 'verified' | 'unknown'  (never 'guess')
    sic              TEXT,
    sic_description  TEXT,
    state            TEXT,                          -- stateOfIncorporation
    status           TEXT,                          -- derived high-level status
    first_seen_at    TEXT,
    last_updated_at  TEXT
);

-- Layer 1 output: one row per filing.
CREATE TABLE IF NOT EXISTS filings (
    accession    TEXT PRIMARY KEY,                  -- e.g. 0001493152-26-016607
    cik          INTEGER NOT NULL,                  -- issuer CIK (FK companies.cik)
    regulation   TEXT NOT NULL,                     -- 'A+' | 'D' | 'S' | '144A'
    form_type    TEXT NOT NULL,                     -- '1-A', 'D', 'S-1', ...
    filing_date  TEXT NOT NULL,                     -- YYYY-MM-DD
    primary_doc  TEXT,                              -- primary document filename
    status       TEXT DEFAULT 'filed',              -- filed|qualified|withdrawn|active|incomplete
    retry_count  INTEGER DEFAULT 0,
    last_error   TEXT,
    FOREIGN KEY (cik) REFERENCES companies(cik)
);
CREATE INDEX IF NOT EXISTS idx_filings_cik ON filings(cik);
CREATE INDEX IF NOT EXISTS idx_filings_reg_date ON filings(regulation, filing_date);

-- Layer 3 output: extracted decision-makers.
CREATE TABLE IF NOT EXISTS officers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cik              INTEGER NOT NULL,
    full_name        TEXT,
    first            TEXT,
    last             TEXT,
    role             TEXT,
    role_priority    INTEGER DEFAULT 99,            -- lower = more senior (config.OFFICER_ROLE_PRIORITY)
    source_accession TEXT,                          -- filing the officer was extracted from
    source_type      TEXT,                          -- 'formd_xml' | 'html_1a' | 'html_sf'
    rank             INTEGER,                        -- computed rank within company
    is_top_3         INTEGER DEFAULT 0,
    FOREIGN KEY (cik) REFERENCES companies(cik),
    FOREIGN KEY (source_accession) REFERENCES filings(accession)
);
CREATE INDEX IF NOT EXISTS idx_officers_cik ON officers(cik);
-- Same person disclosed across multiple filings should collapse to one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_officer_identity
    ON officers(cik, full_name, role);

-- Layer 4 output: candidate + verified addresses, one row per (officer × pattern) attempt.
CREATE TABLE IF NOT EXISTS emails (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cik                 INTEGER NOT NULL,
    officer_id          INTEGER NOT NULL,
    address             TEXT NOT NULL,
    pattern             TEXT,                        -- which template produced it
    verification_status TEXT DEFAULT 'not_attempted', -- verified|unverified|catchall|rejected|not_attempted
    response_code       TEXT,                        -- raw SMTP code or API response
    verified_at         TEXT,
    FOREIGN KEY (cik) REFERENCES companies(cik),
    FOREIGN KEY (officer_id) REFERENCES officers(id)
);
CREATE INDEX IF NOT EXISTS idx_emails_officer ON emails(officer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attempt ON emails(officer_id, address);

-- Resumability: phase progress markers (brief §7 Phase 5).
-- key e.g. 'discovery:D:2024' -> value 'done' or a paging offset.
CREATE TABLE IF NOT EXISTS checkpoints (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT
);

-- Work that failed and should be retried (brief §9 edge cases).
CREATE TABLE IF NOT EXISTS retry_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,                   -- 'submissions' | 'formd' | 'html' | 'discovery'
    ref             TEXT NOT NULL,                   -- cik or accession the work targets
    attempts        INTEGER DEFAULT 0,
    next_attempt_at TEXT,
    last_error      TEXT,
    created_at      TEXT,
    UNIQUE(kind, ref)
);

-- Observability: every outbound SEC request (brief §7 Phase 0 "fetch_log").
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
