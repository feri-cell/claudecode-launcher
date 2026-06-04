"""Phase 1 tests.

Offline tests parse a saved EFTS response so CI never hits the network. The
brief's acceptance test (TerraCycle / Aurora Mobile / Eagle Nuclear resolve to
distinct issuer CIKs, not the shared filer-agent CIK 1104659) runs live and is
gated behind EDGAR_NETWORK_TESTS=1.
"""

import json
import os

import pytest

from msc_edgar.discovery import (
    FilingRecord,
    _persist_page,
    clean_company_name,
    parse_hit,
)


def test_clean_company_name_strips_cik_suffix():
    assert clean_company_name("TerraCycle US Inc.  (CIK 0001714781)") == "TerraCycle US Inc."
    # A ticker in parentheses is left alone; only the CIK suffix is removed.
    assert clean_company_name("DISCOUNT PRINT USA, INC.  (DPUI)  (CIK 0001791929)") \
        == "DISCOUNT PRINT USA, INC. (DPUI)"


def test_parse_hit_uses_issuer_cik_not_accession_prefix():
    hit = {
        "_id": "0001096906-26-000272:primary_doc.xml",
        "_source": {
            "ciks": ["0001791929", "0001096906"],  # [0] issuer, [1] filer agent
            "display_names": ["DISCOUNT PRINT USA, INC. (CIK 0001791929)"],
            "form": "1-A",
            "file_date": "2026-02-27",
            "adsh": "0001096906-26-000272",
        },
    }
    rec = parse_hit(hit)
    assert rec.cik == 1791929               # issuer, NOT 1096906 (the accession prefix)
    assert rec.accession == "0001096906-26-000272"
    assert rec.primary_doc == "primary_doc.xml"
    assert rec.form_type == "1-A"
    assert "(CIK" not in rec.company_name


def test_parse_hit_without_ciks_returns_none():
    assert parse_hit({"_source": {"ciks": []}}) is None


def test_fixture_every_hit_parses_with_consistent_issuer(fixtures_dir):
    data = json.loads((fixtures_dir / "efts_1a_sample.json").read_text())
    hits = data["hits"]["hits"]
    assert hits, "fixture should contain hits"
    for h in hits:
        rec = parse_hit(h, "1-A")
        assert rec is not None
        # Issuer CIK is exactly ciks[0] with leading zeros stripped.
        assert rec.cik == int(h["_source"]["ciks"][0].lstrip("0"))
        assert rec.accession and ":" not in rec.accession


def test_persist_page_writes_company_and_filing(tmp_db):
    from msc_edgar.db import connect

    conn = connect(tmp_db)
    try:
        recs = [
            FilingRecord("0001-26-000001", 1714781, "TerraCycle US Inc.",
                         "1-A", "2026-03-20", "primary_doc.xml"),
            FilingRecord("0001-26-000002", 1737339, "Aurora Mobile Ltd",
                         "F-3", "2024-05-01", "primary_doc.xml"),
        ]
        _persist_page(conn, "A+", recs)
        # Re-persisting the same page is a no-op (idempotent).
        _persist_page(conn, "A+", recs)
        n_companies = conn.execute("SELECT COUNT(*) c FROM companies").fetchone()["c"]
        n_filings = conn.execute("SELECT COUNT(*) c FROM filings").fetchone()["c"]
        assert n_companies == 2
        assert n_filings == 2
        cik = conn.execute(
            "SELECT cik FROM filings WHERE accession='0001-26-000001'"
        ).fetchone()["cik"]
        assert cik == 1714781
    finally:
        conn.close()


@pytest.mark.skipif(
    os.environ.get("EDGAR_NETWORK_TESTS") != "1",
    reason="set EDGAR_NETWORK_TESTS=1 to run live SEC acceptance test",
)
def test_known_issuers_get_distinct_ciks_live():
    """Brief §7 Phase 1 acceptance: the three companies that share filer-agent
    CIK 1104659 in the old CSV must resolve to three distinct issuer CIKs."""
    import httpx

    from config import USER_AGENT

    c = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30)
    expected = {"TerraCycle": 1714781, "Aurora Mobile": 1737339, "Eagle Nuclear": 2089283}
    got = {}
    for name, exp in expected.items():
        r = c.get("https://efts.sec.gov/LATEST/search-index",
                  params={"q": f'"{name}"', "size": 1})
        rec = parse_hit(r.json()["hits"]["hits"][0])
        got[name] = rec.cik
        assert rec.cik == exp, f"{name}: expected {exp}, got {rec.cik}"
    assert len(set(got.values())) == 3            # all distinct
    assert 1104659 not in got.values()            # never the filer-agent CIK
