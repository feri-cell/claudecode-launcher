"""Layer 1 — Discovery.

Query EFTS full-text search for every (regulation, form, year) tuple in scope
and record each filing with the **correct issuer CIK** (``_source.ciks[0]``),
never the filer-agent CIK embedded in the accession number.

Key facts about the live EFTS API (verified empirically, they differ from the
brief's draft URL):
  * Endpoint: GET https://efts.sec.gov/LATEST/search-index
  * Date filter params are ``startdt`` / ``enddt`` (ISO). There is no
    ``dateRange`` param — sending ``dateRange=custom`` returns HTTP 500.
  * Page size is 100; ``from`` is a literal offset and is capped at 10,000.
    A query whose total exceeds 10,000 must be split into smaller date windows,
    which we do by recursive bisection.
  * ``hits.total.relation`` is ``"eq"`` for an exact count or ``"gte"`` when the
    true total is clamped at 10,000.
  * ``_source.adsh`` is the clean accession; ``_id`` is ``"{adsh}:{filename}"``.
"""

from __future__ import annotations

import argparse
import asyncio
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from config import (
    EFTS_PAGE_SIZE,
    EFTS_RESULT_CAP,
    EFTS_SEARCH_URL,
    HISTORICAL_START,
    REGULATION_FORMS,
)
from msc_edgar.db import connect, init_db, utcnow_iso
from msc_edgar.http_client import SecClient

# Matches a trailing "(CIK 0001234567)" suffix on EFTS display_names.
_CIK_SUFFIX_RE = re.compile(r"\s*\(CIK\s*\d+\)\s*$", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Pure parsing helpers (no network — unit-tested against a saved fixture)
# --------------------------------------------------------------------------- #
@dataclass
class FilingRecord:
    accession: str
    cik: int           # issuer CIK, leading zeros stripped
    company_name: str  # cleaned, "(CIK ...)" suffix removed
    form_type: str
    filing_date: str   # YYYY-MM-DD
    primary_doc: str | None


def clean_company_name(display_name: str) -> str:
    """Strip the trailing ``(CIK ...)`` suffix and collapse whitespace."""
    name = _CIK_SUFFIX_RE.sub("", display_name or "")
    return re.sub(r"\s+", " ", name).strip()


def parse_hit(hit: dict, form_fallback: str | None = None) -> FilingRecord | None:
    """Turn one EFTS hit into a FilingRecord, or None if it lacks an issuer CIK."""
    src = hit.get("_source", {})
    ciks = src.get("ciks") or []
    if not ciks:
        return None
    issuer_cik = int(str(ciks[0]).lstrip("0") or "0")
    if issuer_cik == 0:
        return None

    accession = src.get("adsh") or str(hit.get("_id", "")).split(":", 1)[0]
    _id = str(hit.get("_id", ""))
    primary_doc = _id.split(":", 1)[1] if ":" in _id else None

    names = src.get("display_names") or [""]
    company_name = clean_company_name(names[0])

    return FilingRecord(
        accession=accession,
        cik=issuer_cik,
        company_name=company_name,
        form_type=src.get("form") or form_fallback or "",
        filing_date=src.get("file_date") or "",
        primary_doc=primary_doc,
    )


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def _persist_page(conn, regulation: str, records: list[FilingRecord]) -> int:
    """Upsert companies then filings for one page. Returns rows newly written."""
    if not records:
        return 0
    now = utcnow_iso()
    # Companies first (FK target). Don't clobber a name set by a later phase.
    conn.executemany(
        "INSERT INTO companies (cik, name, website_source, first_seen_at, last_updated_at) "
        "VALUES (?, ?, 'unknown', ?, ?) "
        "ON CONFLICT(cik) DO UPDATE SET name = COALESCE(companies.name, excluded.name)",
        [(r.cik, r.company_name, now, now) for r in records],
    )
    cur = conn.executemany(
        "INSERT INTO filings (accession, cik, regulation, form_type, filing_date, "
        "primary_doc, status) VALUES (?, ?, ?, ?, ?, ?, 'filed') "
        "ON CONFLICT(accession) DO NOTHING",
        [(r.accession, r.cik, regulation, r.form_type, r.filing_date, r.primary_doc)
         for r in records],
    )
    conn.commit()
    return cur.rowcount if cur.rowcount is not None else 0


def _get_checkpoint(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM checkpoints WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _set_checkpoint(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO checkpoints (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, utcnow_iso()),
    )
    conn.commit()


# --------------------------------------------------------------------------- #
# EFTS querying
# --------------------------------------------------------------------------- #
def _iso(d: date) -> str:
    return d.isoformat()


async def _query(sec: SecClient, form: str, start: date, end: date, frm: int):
    """One EFTS page. Returns (total_value, relation, list_of_hits)."""
    params = {
        "forms": form,
        "startdt": _iso(start),
        "enddt": _iso(end),
        "from": frm,
        "size": EFTS_PAGE_SIZE,
    }
    j = await sec.get_json(EFTS_SEARCH_URL, params)
    hits = j.get("hits", {})
    total = hits.get("total", {})
    return total.get("value", 0), total.get("relation", "eq"), hits.get("hits", [])


async def _discover_window(sec, conn, reg: str, form: str, start: date, end: date,
                           stats: dict) -> None:
    """Recursively discover all filings of one form in [start, end].

    Bisects the date range whenever a window's total would exceed the 10k
    pagination cap, so we never silently truncate a busy window.
    """
    total, relation, first = await _query(sec, form, start, end, 0)
    if total == 0:
        return

    over_cap = relation != "eq" or total >= EFTS_RESULT_CAP
    if over_cap and start < end:
        mid = start + (end - start) // 2
        await _discover_window(sec, conn, reg, form, start, mid, stats)
        await _discover_window(sec, conn, reg, form, mid + timedelta(days=1), end, stats)
        return

    # Leaf window: page through up to the cap, reusing the first page.
    records = [r for h in first if (r := parse_hit(h, form))]
    stats["written"] += _persist_page(conn, reg, records)
    frm = len(first)
    while frm < total and frm < EFTS_RESULT_CAP:
        _, _, hits = await _query(sec, form, start, end, frm)
        if not hits:
            break
        records = [r for h in hits if (r := parse_hit(h, form))]
        stats["written"] += _persist_page(conn, reg, records)
        frm += len(hits)

    if over_cap and start >= end:
        # Single day still over the cap — cannot bisect further.
        dropped = max(0, total - EFTS_RESULT_CAP)
        stats["dropped"] += dropped
        print(f"  ! {form} {start} exceeds 10k cap; "
              f"~{dropped} filings beyond 10,000 NOT retrieved")


def _years(start: date, end: date):
    return range(start.year, end.year + 1)


async def discover(regulations: list[str] | None = None,
                   start: date = HISTORICAL_START,
                   end: date | None = None,
                   db_path=None) -> dict:
    """Run discovery for the given regulations over [start, end].

    Checkpoints per (regulation, form, year) so a crash resumes cleanly.
    Returns summary stats.
    """
    end = end or date.today()
    regulations = regulations or list(REGULATION_FORMS)
    init_db() if db_path is None else init_db(db_path)
    conn = connect() if db_path is None else connect(db_path)
    stats = {"written": 0, "dropped": 0, "skipped": 0}
    try:
        async with SecClient() as sec:
            for reg in regulations:
                for form in REGULATION_FORMS[reg]:
                    for year in _years(start, end):
                        y0 = max(start, date(year, 1, 1))
                        y1 = min(end, date(year, 12, 31))
                        if y0 > y1:
                            continue
                        key = f"discovery:{reg}:{form}:{year}"
                        if _get_checkpoint(conn, key) == "done":
                            stats["skipped"] += 1
                            continue
                        before = stats["written"]
                        await _discover_window(sec, conn, reg, form, y0, y1, stats)
                        _set_checkpoint(conn, key, "done")
                        n = stats["written"] - before
                        print(f"  {reg:4} {form:7} {year}: +{n} filings")
    finally:
        conn.close()
    print(f"\nDiscovery complete: {stats['written']} filings written, "
          f"{stats['skipped']} (reg,form,year) tuples already done, "
          f"{stats['dropped']} dropped to cap.")
    return stats


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main() -> None:
    ap = argparse.ArgumentParser(description="EDGAR discovery (Layer 1)")
    ap.add_argument("--reg", action="append", choices=list(REGULATION_FORMS),
                    help="Regulation(s) to discover (default: all)")
    ap.add_argument("--start", type=_parse_date, default=HISTORICAL_START,
                    help="Start date YYYY-MM-DD (default: 2022-01-01)")
    ap.add_argument("--end", type=_parse_date, default=date.today(),
                    help="End date YYYY-MM-DD (default: today)")
    args = ap.parse_args()
    print(f"Discovery: regs={args.reg or 'all'} {args.start}..{args.end}")
    asyncio.run(discover(args.reg, args.start, args.end))


if __name__ == "__main__":
    main()
