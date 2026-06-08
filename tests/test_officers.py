"""Phase 3 — officer parsers, the XPath-scoping guard, ranking, persistence."""

from msc_edgar.db import connect
from msc_edgar.officers import (
    Officer,
    _store_officers,
    is_person_name,
    parse_form_d_xml,
    parse_html_officers,
    recompute_top3,
    source_type_for_form,
    split_name,
)


# --- name heuristics ------------------------------------------------------- #
def test_is_person_name_accepts_real_names():
    assert is_person_name("Jane Smith")
    assert is_person_name("Robert K. Lindqvist")
    assert is_person_name("Maria Gonzalez")


def test_is_person_name_rejects_entities_and_places():
    for junk in ["Delaware", "Acme Inc", "TerraCycle LLC", "New York",
                 "Smith", "Capital Partners LP", "52"]:
        assert not is_person_name(junk), junk


def test_split_name():
    assert split_name("Jane R Smith") == ("Jane", "Smith")
    assert split_name("Maria Gonzalez") == ("Maria", "Gonzalez")


# --- Form D XML: the dup-officer guard ------------------------------------- #
def test_formd_synthetic_returns_two_distinct_officers(fixtures_dir):
    xml = (fixtures_dir / "formd_two_officers.xml").read_bytes()
    offs = parse_form_d_xml(xml)
    names = [o.full_name for o in offs]
    assert names == ["Jane R Smith", "John Doe"]          # distinct, in order
    # relationshipClarification supplies the specific title.
    assert offs[0].role == "Chief Executive Officer"
    assert offs[0].role_priority == 1


def test_formd_real_filing_distinct_persons(fixtures_dir):
    """Real Form D (no namespace) with three related persons."""
    offs = parse_form_d_xml((fixtures_dir / "formd_real.xml").read_bytes())
    names = {o.full_name for o in offs}
    assert names == {"Christopher Palermo", "Anthony Grosso", "Rich Koenig"}
    # One has clarification "Treasurer"; others fall back to "Executive Officer".
    koenig = next(o for o in offs if o.last == "Koenig")
    assert koenig.role == "Treasurer"


# --- HTML parsers ---------------------------------------------------------- #
def test_html_1a_table_and_signatures(fixtures_dir):
    offs = parse_html_officers((fixtures_dir / "reg_a_1a.html").read_text(), "html_1a")
    names = {o.full_name for o in offs}
    assert "Maria Gonzalez" in names
    assert "David Okafor" in names
    assert "Priya Nair" in names            # picked up from the signature block
    assert "Delaware" not in names          # false positive rejected


def test_html_s1_management_table(fixtures_dir):
    offs = parse_html_officers((fixtures_dir / "s1_management.html").read_text(), "html_sf")
    by_last = {o.last: o for o in offs}
    assert set(by_last) == {"Lindqvist", "Bello", "Reyes"}
    assert by_last["Lindqvist"].role_priority == 1   # "President and CEO" -> CEO


# --- router ---------------------------------------------------------------- #
def test_router():
    assert source_type_for_form("D") == "formd_xml"
    assert source_type_for_form("D/A") == "formd_xml"   # amendment shares Form D XML
    assert source_type_for_form("1-A") == "html_1a"
    assert source_type_for_form("1-A/A") == "html_1a"
    assert source_type_for_form("253G2") == "html_1a"
    assert source_type_for_form("S-1") == "html_sf"
    assert source_type_for_form("F-3") == "html_sf"


# --- persistence + ranking ------------------------------------------------- #
def test_store_and_rank_top3(tmp_db):
    conn = connect(tmp_db)
    try:
        conn.execute("INSERT INTO companies (cik, name) VALUES (1, 'Acme')")
        conn.execute("INSERT INTO filings (accession, cik, regulation, form_type, filing_date) "
                     "VALUES ('a1', 1, 'A+', '1-A', '2025-01-01')")
        conn.commit()
        officers = [
            Officer("Zoe Director", "Zoe", "Director", "Director", "html_1a"),
            Officer("Carl CEO", "Carl", "CEO", "Chief Executive Officer", "html_1a"),
            Officer("Fran CFO", "Fran", "CFO", "Chief Financial Officer", "html_1a"),
            Officer("Ida Counsel", "Ida", "Counsel", "General Counsel", "html_1a"),
        ]
        _store_officers(conn, 1, "a1", officers)
        conn.commit()
        recompute_top3(conn, 1)
        conn.commit()
        rows = conn.execute(
            "SELECT last, rank, is_top_3 FROM officers WHERE cik=1 ORDER BY rank"
        ).fetchall()
        ranked = [(r["last"], r["is_top_3"]) for r in rows]
        # CEO(1) < CFO(5) < Counsel(7) < Director(10); top-3 flagged.
        assert [r["last"] for r in rows] == ["CEO", "CFO", "Counsel", "Director"]
        assert ranked[:3] == [("CEO", 1), ("CFO", 1), ("Counsel", 1)]
        assert ranked[3] == ("Director", 0)
    finally:
        conn.close()


def test_store_officers_dedupes(tmp_db):
    conn = connect(tmp_db)
    try:
        conn.execute("INSERT INTO companies (cik, name) VALUES (1, 'Acme')")
        for acc in ("a1", "a2"):
            conn.execute("INSERT INTO filings (accession, cik, regulation, form_type, "
                         "filing_date) VALUES (?, 1, 'D', 'D', '2025-01-01')", (acc,))
        conn.commit()
        o = [Officer("Carl CEO", "Carl", "CEO", "Chief Executive Officer", "formd_xml")]
        _store_officers(conn, 1, "a1", o)
        _store_officers(conn, 1, "a2", o)   # same (cik, name, role) -> ignored
        conn.commit()
        n = conn.execute("SELECT COUNT(*) c FROM officers WHERE cik=1").fetchone()["c"]
        assert n == 1
    finally:
        conn.close()
