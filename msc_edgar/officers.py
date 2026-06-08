"""Layer 3 — Officer extraction.

Three parsers behind one router:
  * Form D ``primary_doc.xml`` — structured, namespace-tolerant XPath, the bulk
    of all filings and the highest-yield source.
  * 1-A / 253G HTML — Item 10 "Directors, Executive Officers" table + signatures.
  * S / F-series HTML — "Management" / "Executive Officers and Directors" table.

Extracted officers are ranked by seniority and the top-3 per company flagged.
An optional LLM fallback (msc_edgar.llm) handles HTML the heuristics miss.
"""

from __future__ import annotations

import argparse
import asyncio
import re
from dataclasses import dataclass, field

from lxml import etree

from config import TOP_N_OFFICERS, WORKER_COUNT
from msc_edgar.db import connect, init_db, utcnow_iso
from msc_edgar.http_client import SecClient
from msc_edgar.roles import looks_like_role, role_priority

# --------------------------------------------------------------------------- #
# Name handling / false-positive rejection
# --------------------------------------------------------------------------- #
# Tokens that mean a "name" is really an entity or a place, not a human.
_REJECT_TOKENS = {
    "inc", "llc", "l.l.c", "corp", "corporation", "ltd", "limited", "lp", "l.p",
    "llp", "plc", "company", "co", "holdings", "holding", "trust", "fund", "group",
    "partners", "capital", "ventures", "management", "advisors", "associates",
    "bank", "na", "n.a", "sa", "ag", "gmbh", "pllc", "pc",
}
_US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
    "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
    "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
    "nebraska", "nevada", "hampshire", "jersey", "mexico", "york", "carolina",
    "dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode", "tennessee",
    "texas", "utah", "vermont", "virginia", "washington", "wisconsin", "wyoming",
}
# A name: a capitalized first token, optional middle initial/name, 1-2 surnames.
_NAME_RE = re.compile(
    r"^[A-Z][A-Za-z.'\-]+(?:\s+(?:[A-Z]\.?|[A-Z][A-Za-z.'\-]+)){1,3}$"
)


def is_person_name(text: str) -> bool:
    """Heuristic: looks like a human name, not an entity or place."""
    if not text:
        return False
    name = re.sub(r"\s+", " ", text).strip().strip(",")
    if not _NAME_RE.match(name):
        return False
    toks = [t.lower().strip(".") for t in name.split()]
    if len(toks) < 2:
        return False
    if any(t in _REJECT_TOKENS for t in toks):
        return False
    if any(t in _US_STATES for t in toks):
        return False
    return True


def split_name(full: str) -> tuple[str, str]:
    """Split a display name into (first, last). Last token is the surname."""
    parts = re.sub(r"\s+", " ", full).strip().strip(",").split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[-1]


# --------------------------------------------------------------------------- #
# Officer model
# --------------------------------------------------------------------------- #
@dataclass
class Officer:
    full_name: str
    first: str
    last: str
    role: str
    source_type: str
    role_priority: int = field(default=0)

    def __post_init__(self):
        if not self.role_priority:
            self.role_priority = role_priority(self.role)


def _make_officer(full_name: str, role: str, source_type: str) -> Officer | None:
    full_name = re.sub(r"\s+", " ", full_name or "").strip().strip(",")
    if not is_person_name(full_name):
        return None
    first, last = split_name(full_name)
    if not last:
        return None
    return Officer(full_name=full_name, first=first, last=last,
                   role=(role or "").strip(), source_type=source_type)


# --------------------------------------------------------------------------- #
# Parser 1 — Form D XML (structured)
# --------------------------------------------------------------------------- #
def _lx(node, tag: str) -> list[str]:
    """Relative, namespace-tolerant text lookup scoped to ``node``.

    Using a RELATIVE XPath ('.//') scoped to the per-person node is essential:
    an absolute '//' would match every person in the document on each iteration
    and duplicate the first person N times (the prior-build bug, brief §3a).
    """
    return [t.strip() for t in node.xpath(f".//*[local-name()=$t]/text()", t=tag) if t.strip()]


def parse_form_d_xml(xml: bytes | str) -> list[Officer]:
    """Parse related persons from a Form D ``primary_doc.xml``."""
    if isinstance(xml, str):
        xml = xml.encode("utf-8")
    try:
        root = etree.fromstring(xml)
    except etree.XMLSyntaxError:
        return []

    officers: list[Officer] = []
    for person in root.xpath(".//*[local-name()='relatedPersonInfo']"):
        first = (_lx(person, "firstName") or [""])[0]
        middle = (_lx(person, "middleName") or [""])[0]
        last = (_lx(person, "lastName") or [""])[0]
        if not (first and last):
            continue
        full = " ".join(p for p in (first, middle, last) if p)

        # Specific title if disclosed, else the most senior checkbox relationship.
        clar = (_lx(person, "relationshipClarification") or [""])[0]
        rels = _lx(person, "relationship")
        if clar:
            role = clar
        elif rels:
            role = min(rels, key=role_priority)
        else:
            role = ""

        off = _make_officer(full, role, "formd_xml")
        if off:
            officers.append(off)
    return officers


# --------------------------------------------------------------------------- #
# Parser 2/3 — HTML (1-A / 253G / S / F-series)
# --------------------------------------------------------------------------- #
# A role keyword, optionally preceded by title words ("Chief Executive Officer",
# "Vice President") but also matching a bare keyword on its own ("Director").
_ROLE_KW = (
    r"(?:Officer|President|Director|Chairman|Secretary|Treasurer|Counsel|"
    r"Manager|Member|Founder|CEO|CFO|COO|CTO)"
)
_SIG_RE = re.compile(
    r"(?:/s/\s*)?([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3})\s*,\s*"
    r"((?:[A-Z][A-Za-z]+[ &/]+)*" + _ROLE_KW + r")"
)


def parse_html_officers(html: str, source_type: str) -> list[Officer]:
    """Extract officers from a filing's HTML body via table + signature heuristics."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    found: dict[str, Officer] = {}

    # 1) Tables: in each row, pair a name-like cell with a role-like cell.
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in row.find_all(["td", "th"])]
            name_cell = next((c for c in cells if is_person_name(c)), None)
            role_cell = next((c for c in cells if c is not name_cell and looks_like_role(c)), None)
            if name_cell and role_cell:
                off = _make_officer(name_cell, role_cell, source_type)
                if off:
                    found.setdefault(off.full_name.lower(), off)

    # 2) Signature lines: "Name, Role" / "/s/ Name, Role".
    text = soup.get_text("\n")
    for m in _SIG_RE.finditer(text):
        off = _make_officer(m.group(1), m.group(2), source_type)
        if off:
            found.setdefault(off.full_name.lower(), off)

    return list(found.values())


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
def source_type_for_form(form_type: str) -> str:
    # Strip the amendment suffix: "D/A" and "1-A/A" share the base form's
    # document structure, so they must route to the same parser.
    base = (form_type or "").upper().split("/")[0]
    if base == "D":
        return "formd_xml"
    if base.startswith("1-A") or base.startswith("253G"):
        return "html_1a"
    return "html_sf"


def parse_document(form_type: str, content: bytes | str) -> list[Officer]:
    st = source_type_for_form(form_type)
    if st == "formd_xml":
        return parse_form_d_xml(content)
    html = content.decode("utf-8", "replace") if isinstance(content, bytes) else content
    return parse_html_officers(html, st)


# --------------------------------------------------------------------------- #
# Persistence + ranking
# --------------------------------------------------------------------------- #
def _store_officers(conn, cik: int, accession: str, officers: list[Officer]) -> int:
    rows = [
        (cik, o.full_name, o.first, o.last, o.role, o.role_priority, accession, o.source_type)
        for o in officers
    ]
    cur = conn.executemany(
        "INSERT INTO officers (cik, full_name, first, last, role, role_priority, "
        "source_accession, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(cik, full_name, role) DO NOTHING",
        rows,
    )
    return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def recompute_top3(conn, cik: int) -> None:
    """Re-rank a company's officers: role_priority ASC, then newest filing first."""
    rows = conn.execute(
        """
        SELECT o.id FROM officers o
        LEFT JOIN filings f ON f.accession = o.source_accession
        WHERE o.cik = ?
        ORDER BY o.role_priority ASC, COALESCE(f.filing_date, '') DESC, o.id ASC
        """,
        (cik,),
    ).fetchall()
    for rank, r in enumerate(rows, start=1):
        conn.execute(
            "UPDATE officers SET rank = ?, is_top_3 = ? WHERE id = ?",
            (rank, 1 if rank <= TOP_N_OFFICERS else 0, r["id"]),
        )


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
async def _fetch_doc(sec: SecClient, sem, cik: int, accession: str, primary_doc: str | None):
    nod = accession.replace("-", "")
    doc = primary_doc or "primary_doc.xml"
    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{nod}/{doc}"
    async with sem:
        try:
            return await sec.get_bytes(url), None
        except Exception as exc:  # noqa: BLE001
            return None, repr(exc)


def _pending_filings(conn, regs, limit):
    q = "SELECT accession, cik, form_type, primary_doc FROM filings WHERE status='filed'"
    params: list = []
    if regs:
        q += f" AND regulation IN ({','.join('?' * len(regs))})"
        params += regs
    q += " ORDER BY filing_date DESC"
    if limit:
        q += " LIMIT ?"
        params.append(limit)
    return conn.execute(q, params).fetchall()


def _set_filing_status(conn, accession: str, status: str, error: str | None = None) -> None:
    conn.execute(
        "UPDATE filings SET status = ?, last_error = ? WHERE accession = ?",
        (status, error, accession),
    )


async def extract_officers(db_path=None, regulations=None, limit=None,
                           use_llm=True, batch_size=50) -> dict:
    """Fetch each pending filing's primary document, extract officers, rank top-3."""
    init_db() if db_path is None else init_db(db_path)
    conn = connect() if db_path is None else connect(db_path)
    stats = {"parsed": 0, "incomplete": 0, "officers": 0, "llm_used": 0, "failed": 0}

    llm = None
    if use_llm:
        try:
            from msc_edgar import llm as llm_mod
            llm = llm_mod if llm_mod.is_configured() else None
        except Exception:  # noqa: BLE001
            llm = None

    try:
        pending = _pending_filings(conn, regulations, limit)
        print(f"Officer extraction: {len(pending)} filings pending"
              + (" (LLM fallback ON)" if llm else " (heuristics only)"))
        sem = asyncio.Semaphore(WORKER_COUNT)
        touched: set[int] = set()

        async with SecClient() as sec:
            for i in range(0, len(pending), batch_size):
                batch = pending[i:i + batch_size]
                docs = await asyncio.gather(*[
                    _fetch_doc(sec, sem, f["cik"], f["accession"], f["primary_doc"])
                    for f in batch
                ])
                for f, (content, error) in zip(batch, docs):
                    if content is None:
                        _set_filing_status(conn, f["accession"], "incomplete", error)
                        _enqueue_retry(conn, f["accession"], error or "fetch failed")
                        stats["failed"] += 1
                        continue

                    officers = parse_document(f["form_type"], content)

                    # LLM fallback for HTML forms the heuristics missed.
                    if not officers and llm and source_type_for_form(f["form_type"]) != "formd_xml":
                        try:
                            html = content.decode("utf-8", "replace")
                            llm_officers = await llm.extract_officers(html, source_type_for_form(f["form_type"]))
                            officers = [o for o in (
                                _make_officer(d.get("name", ""), d.get("role", ""),
                                              source_type_for_form(f["form_type"]) + "_llm")
                                for d in (llm_officers or [])) if o]
                            if officers:
                                stats["llm_used"] += 1
                        except Exception:  # noqa: BLE001
                            pass

                    if officers:
                        stats["officers"] += _store_officers(conn, f["cik"], f["accession"], officers)
                        _set_filing_status(conn, f["accession"], "parsed")
                        stats["parsed"] += 1
                        touched.add(f["cik"])
                    else:
                        _set_filing_status(conn, f["accession"], "incomplete", "no officers found")
                        _enqueue_retry(conn, f["accession"], "no officers found")
                        stats["incomplete"] += 1
                conn.commit()
                print(f"  …{stats['parsed']} parsed, {stats['incomplete']} incomplete, "
                      f"{stats['officers']} officers, {stats['failed']} fetch-fail")

            for cik in touched:
                recompute_top3(conn, cik)
            conn.commit()
    finally:
        conn.close()
    print(f"\nExtraction complete: {stats['parsed']} filings parsed, "
          f"{stats['officers']} officers stored, {stats['incomplete']} incomplete, "
          f"{stats['llm_used']} via LLM, {stats['failed']} fetch failures.")
    return stats


def _enqueue_retry(conn, accession: str, error: str) -> None:
    conn.execute(
        "INSERT INTO retry_queue (kind, ref, attempts, last_error, created_at) "
        "VALUES ('officers', ?, 1, ?, ?) "
        "ON CONFLICT(kind, ref) DO UPDATE SET attempts = retry_queue.attempts + 1, "
        "last_error = excluded.last_error",
        (accession, error[:300], utcnow_iso()),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Officer extraction (Layer 3)")
    ap.add_argument("--reg", action="append")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--no-llm", action="store_true", help="disable LLM fallback")
    args = ap.parse_args()
    asyncio.run(extract_officers(regulations=args.reg, limit=args.limit,
                                 use_llm=not args.no_llm))


if __name__ == "__main__":
    main()
