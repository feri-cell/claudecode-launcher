"""Phase 0 acceptance: the schema initialises and every expected table exists."""

from msc_edgar.db import connect, init_db, table_names, utcnow_iso

EXPECTED_TABLES = {
    "companies", "filings", "officers", "emails",
    "checkpoints", "retry_queue", "fetch_log",
}


def test_init_creates_all_tables(tmp_path):
    db = init_db(tmp_path / "x.sqlite3")
    assert db.exists()
    assert EXPECTED_TABLES <= table_names(db)


def test_init_is_idempotent(tmp_path):
    p = tmp_path / "x.sqlite3"
    init_db(p)
    init_db(p)  # second run must not raise
    assert EXPECTED_TABLES <= table_names(p)


def test_company_roundtrip(tmp_db):
    conn = connect(tmp_db)
    try:
        conn.execute(
            "INSERT INTO companies (cik, name, website_source, first_seen_at) "
            "VALUES (?, ?, ?, ?)",
            (1714781, "TerraCycle US Inc.", "unknown", utcnow_iso()),
        )
        conn.commit()
        row = conn.execute(
            "SELECT name, website_source FROM companies WHERE cik=?", (1714781,)
        ).fetchone()
        assert row["name"] == "TerraCycle US Inc."
        assert row["website_source"] == "unknown"
    finally:
        conn.close()


def test_foreign_key_enforced(tmp_db):
    """filings.cik -> companies.cik must be enforced (PRAGMA foreign_keys=ON)."""
    import sqlite3

    conn = connect(tmp_db)
    try:
        try:
            conn.execute(
                "INSERT INTO filings (accession, cik, regulation, form_type, filing_date) "
                "VALUES (?, ?, ?, ?, ?)",
                ("0000000000-00-000000", 999999999, "D", "D", "2024-01-01"),
            )
            conn.commit()
            raised = False
        except sqlite3.IntegrityError:
            raised = True
        assert raised, "expected FK violation for unknown issuer CIK"
    finally:
        conn.close()
