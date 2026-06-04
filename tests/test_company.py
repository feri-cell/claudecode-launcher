"""Phase 2 tests — submissions parsing and enrichment writes (offline)."""

import json

from msc_edgar.company import _apply, normalize_website, parse_submissions
from msc_edgar.db import connect


def test_normalize_website():
    assert normalize_website("https://www.terracycle.com") == "https://www.terracycle.com"
    assert normalize_website("terracycle.com") == "https://terracycle.com"
    assert normalize_website("") is None
    assert normalize_website(None) is None
    assert normalize_website("  ") is None
    assert normalize_website("N/A") is None
    assert normalize_website("notadomain") is None


def test_parse_real_submissions_fixture(fixtures_dir):
    j = json.loads((fixtures_dir / "submissions_terracycle.json").read_text())
    f = parse_submissions(j)
    assert f["name"] == "TerraCycle US Inc."
    assert f["sic"] == "4953"
    assert f["state"] == "DE"
    # This issuer has no website in submissions JSON (the common case).
    assert f["website"] is None
    assert f["website_source"] == "unknown"


def test_parse_uses_investor_website_fallback():
    f = parse_submissions({"name": "Acme", "sic": 1234, "stateOfIncorporation": "CA",
                           "website": "", "investorWebsite": "invest.acme.com"})
    assert f["website"] == "https://invest.acme.com"
    assert f["website_source"] == "verified"


def test_apply_overwrites_name_and_marks_enriched(tmp_db):
    conn = connect(tmp_db)
    try:
        # Seed as discovery would: EFTS name, status NULL.
        conn.execute(
            "INSERT INTO companies (cik, name, website_source, status) "
            "VALUES (1714781, 'TerraCycle US Inc. (stale)', 'unknown', NULL)"
        )
        conn.commit()
        _apply(conn, 1714781, parse_submissions(
            {"name": "TerraCycle US Inc.", "sic": 4953,
             "sicDescription": "Refuse Systems", "stateOfIncorporation": "DE"}))
        conn.commit()
        row = conn.execute("SELECT * FROM companies WHERE cik=1714781").fetchone()
        assert row["name"] == "TerraCycle US Inc."        # canonical overwrote stale
        assert row["sic"] == "4953"
        assert row["state"] == "DE"
        assert row["status"] == "enriched"
        assert row["website"] is None                      # never fabricated
    finally:
        conn.close()
