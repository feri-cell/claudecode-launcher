"""Central configuration for the MSC EDGAR enrichment pipeline.

Every value the pipeline tunes lives here so a single file documents the whole
system's behaviour. See MSC_EDGAR_Enrichment_Brief.md §8 for rationale.
"""

from datetime import date
from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "edgar.sqlite3"
CSV_EXPORT_PATH = DATA_DIR / "edgar_filings.csv"

# --------------------------------------------------------------------------- #
# SEC compliance (brief §10) — non-negotiable
# --------------------------------------------------------------------------- #
# SEC requires a real contact email in the User-Agent or it blocks requests.
USER_AGENT = "Manhattan Street Capital feri@manhattanstreetcapital.com"

REQUESTS_PER_SECOND = 5.0        # SEC ceiling is 10/s per UA; we target 5 for headroom.
WORKER_COUNT = 3                 # async workers sharing the single rate budget
MAX_RETRIES = 5
RETRY_BACKOFF = [1, 5, 30, 120, 600]  # seconds, indexed by attempt number

# --------------------------------------------------------------------------- #
# Coverage window (brief §13 Q4 — 2022 backfill is in-scope by default)
# --------------------------------------------------------------------------- #
HISTORICAL_START = date(2022, 1, 1)
DAILY_RUN_HOUR = 3               # 03:00 local for the incremental cron
DAILY_OVERLAP_DAYS = 2           # re-scan today-2d..today to catch late-posted filings

# --------------------------------------------------------------------------- #
# SEC endpoints
# --------------------------------------------------------------------------- #
# NOTE: the brief documented the EFTS query as
#   ?forms=...&dateRange=custom&startdt=...&enddt=...&from=...&size=100
# but `dateRange=custom` causes an HTTP 500. The working params are
# `forms`, `startdt`, `enddt`, `from`, `size` (no `dateRange`, no required `q`).
# Pinned down empirically against the live API; handled in discovery (Phase 1).
EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data/{cik}/{adsh_nodash}"
EDGAR_BROWSE_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
    "&CIK={cik}&type=&dateb=&owner=include&count=40"
)

EFTS_PAGE_SIZE = 100             # hits per EFTS request
EFTS_RESULT_CAP = 10_000         # EFTS hard cap on any single query; chunk to stay under

# --------------------------------------------------------------------------- #
# Regulation → form types (brief §7 Phase 1)
# --------------------------------------------------------------------------- #
REGULATION_FORMS = {
    "A+":   ["1-A", "1-A/A", "253G1", "253G2", "253G3", "253G4"],
    "D":    ["D"],
    "S":    ["F-1", "F-1/A", "F-3", "F-3/A"],
    "144A": ["S-1", "S-1/A", "S-3", "S-3/A", "F-4", "F-4/A"],
}

# --------------------------------------------------------------------------- #
# Officer ranking (brief §3d) — lower number = more senior.
# Matched against the normalised role string by substring, longest key first,
# so "president and ceo" resolves to CEO (1), not President (2).
# --------------------------------------------------------------------------- #
OFFICER_ROLE_PRIORITY = {
    "chief executive officer": 1, "president and ceo": 1, "president & ceo": 1, "ceo": 1,
    "president": 2,
    "co-founder": 3, "founder": 3,
    "chairman": 4, "chairperson": 4, "chair": 4,
    "chief financial officer": 5, "cfo": 5,
    "chief operating officer": 6, "coo": 6,
    "general counsel": 7, "chief legal officer": 7,
    "secretary": 8,
    "executive officer": 9,
    "director": 10,
}
ROLE_PRIORITY_UNKNOWN = 99
TOP_N_OFFICERS = 3

# --------------------------------------------------------------------------- #
# Email finding (brief §4) — Phase 4
# --------------------------------------------------------------------------- #
# Ordered by empirical frequency. Placeholders: {first} {last} {f} {l}
EMAIL_PATTERNS = [
    "{first}.{last}", "{first}", "{f}{last}", "{first}_{last}",
    "{first}{last}", "{last}", "{first}{l}", "{f}.{last}",
]

SMTP_VERIFICATION_HELO_DOMAIN = "manhattanstreetcapital.com"
SMTP_VERIFICATION_MAIL_FROM = "outreach@manhattanstreetcapital.com"
SMTP_PROBE_TIMEOUT = 10          # seconds
SMTP_PROBES_PER_DOMAIN_PER_DAY = 30
SMTP_SLEEP_BETWEEN_PROBES = 7    # seconds

# Pluggable verifier backend (brief §4c). "smtp" = free Option A.
# "none" = generate guesses only, no live verification (safe default in cloud
# environments where outbound port 25 is blocked). "paid" reserved for Phase 4 Option B.
EMAIL_VERIFIER = "none"
