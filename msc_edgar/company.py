"""Layer 2 — Company enrichment.

For every distinct issuer CIK from discovery, fetch
``data.sec.gov/submissions/CIK{cik}.json`` and upsert the canonical company
record: clean name, SIC, state of incorporation.

Reality check (verified against the live API): the submissions JSON ``website``
and ``investorWebsite`` fields are effectively always empty — even for Apple /
Airbnb / Coinbase. So this layer does **not** generally yield a website; on the
rare occasion one is present we keep it and mark it ``verified``, otherwise the
website stays blank and is resolved later in Layer 4 from a validated homepage.
We never pattern-fabricate a URL (brief §2.2).
"""

from __future__ import annotations

import argparse
import asyncio

from config import SUBMISSIONS_URL, WORKER_COUNT
from msc_edgar.db import connect, init_db, utcnow_iso
from msc_edgar.http_client import SecClient


# --------------------------------------------------------------------------- #
# Pure parsing (no network)
# --------------------------------------------------------------------------- #
def normalize_website(raw: str | None) -> str | None:
    """Return a clean ``https://`` URL, or None if blank/unusable."""
    if not raw:
        return None
    url = raw.strip()
    if not url or url.lower() in {"n/a", "none", "-"}:
        return None
    if "." not in url:
        return None
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def parse_submissions(j: dict) -> dict:
    """Extract the canonical company fields from a submissions JSON document."""
    website = normalize_website(j.get("website")) or normalize_website(j.get("investorWebsite"))
    return {
        "name": (j.get("name") or "").strip() or None,
        "sic": (str(j.get("sic")).strip() or None) if j.get("sic") else None,
        "sic_description": (j.get("sicDescription") or "").strip() or None,
        "state": (j.get("stateOfIncorporation") or "").strip() or None,
        "website": website,
        "website_source": "verified" if website else "unknown",
    }


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def _pending_ciks(conn) -> list[int]:
    """CIKs not yet enriched (status NULL means discovery wrote it, Layer 2 hasn't)."""
    return [r["cik"] for r in conn.execute(
        "SELECT cik FROM companies WHERE status IS NULL ORDER BY cik"
    )]


def _apply(conn, cik: int, fields: dict) -> None:
    """Write enrichment for one company and mark it enriched.

    The submissions JSON ``name`` is canonical and overwrites the EFTS name.
    A blank website never clobbers one already discovered by a later layer.
    """
    conn.execute(
        """
        UPDATE companies SET
            name            = COALESCE(?, name),
            sic             = ?,
            sic_description = ?,
            state           = ?,
            website         = COALESCE(?, website),
            website_source  = CASE WHEN ? IS NOT NULL THEN 'verified'
                                   ELSE website_source END,
            status          = 'enriched',
            last_updated_at = ?
        WHERE cik = ?
        """,
        (fields["name"], fields["sic"], fields["sic_description"], fields["state"],
         fields["website"], fields["website"], utcnow_iso(), cik),
    )


def _mark_attempted(conn, cik: int) -> None:
    """A fetch that failed: mark enriched (one attempt spent) so the main loop
    moves on; the retry_queue handles follow-up."""
    conn.execute(
        "UPDATE companies SET status='enriched', last_updated_at=? WHERE cik=?",
        (utcnow_iso(), cik),
    )


def _enqueue_retry(conn, cik: int, error: str) -> None:
    conn.execute(
        "INSERT INTO retry_queue (kind, ref, attempts, last_error, created_at) "
        "VALUES ('submissions', ?, 1, ?, ?) "
        "ON CONFLICT(kind, ref) DO UPDATE SET attempts = retry_queue.attempts + 1, "
        "last_error = excluded.last_error",
        (str(cik), error[:300], utcnow_iso()),
    )


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
async def _fetch_one(sec: SecClient, sem: asyncio.Semaphore, cik: int):
    """Return (cik, fields_or_None, error_or_None)."""
    url = SUBMISSIONS_URL.format(cik10=f"{cik:010d}")
    async with sem:
        try:
            j = await sec.get_json(url)
            return cik, parse_submissions(j), None
        except Exception as exc:  # noqa: BLE001 — record and continue
            return cik, None, repr(exc)


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


async def enrich_companies(db_path=None, batch_size: int = 200) -> dict:
    """Enrich every pending company. Concurrent fetch, serialized writes."""
    init_db() if db_path is None else init_db(db_path)
    conn = connect() if db_path is None else connect(db_path)
    stats = {"enriched": 0, "with_website": 0, "failed": 0}
    try:
        pending = _pending_ciks(conn)
        print(f"Company enrichment: {len(pending)} companies pending")
        sem = asyncio.Semaphore(WORKER_COUNT)
        async with SecClient() as sec:
            for batch in _chunks(pending, batch_size):
                results = await asyncio.gather(
                    *[_fetch_one(sec, sem, cik) for cik in batch]
                )
                for cik, fields, error in results:
                    if fields is not None:
                        _apply(conn, cik, fields)
                        stats["enriched"] += 1
                        if fields["website"]:
                            stats["with_website"] += 1
                    else:
                        _mark_attempted(conn, cik)
                        _enqueue_retry(conn, cik, error or "unknown")
                        stats["failed"] += 1
                conn.commit()
                print(f"  …{stats['enriched']} enriched "
                      f"({stats['with_website']} w/ website), {stats['failed']} failed")
    finally:
        conn.close()
    print(f"\nEnrichment complete: {stats['enriched']} companies, "
          f"{stats['with_website']} with a website, {stats['failed']} failed.")
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description="Company enrichment (Layer 2)")
    ap.add_argument("--batch-size", type=int, default=200)
    args = ap.parse_args()
    asyncio.run(enrich_companies(batch_size=args.batch_size))


if __name__ == "__main__":
    main()
