"""Phase 0 acceptance: the parser fixtures are present and well-formed.

The actual parsing logic lands in Phase 3; here we only guarantee the fixtures
are committed and structurally valid so later parser tests have inputs.
"""

from lxml import etree


def test_formd_fixture_has_two_distinct_persons(fixtures_dir):
    """Guards the input to the XPath-scoping test: the fixture really has two
    different people (so a buggy absolute-XPath parser would be caught)."""
    tree = etree.parse(str(fixtures_dir / "formd_two_officers.xml"))
    last_names = tree.xpath("//*[local-name()='lastName']/text()")
    assert last_names == ["Smith", "Doe"]


def test_html_fixtures_present_and_nonempty(fixtures_dir):
    for name in ("reg_a_1a.html", "s1_management.html"):
        text = (fixtures_dir / name).read_text(encoding="utf-8")
        assert "<table" in text and "Chief Executive Officer" in text or "Chief Financial" in text
