"""Phase 3 — role normalization and ranking."""

from msc_edgar.roles import looks_like_role, normalize_role, role_priority


def test_president_and_ceo_resolves_to_ceo():
    # The founder-CEO trap: must NOT under-rank to President (2).
    assert role_priority("President and CEO") == 1
    assert role_priority("President & Chief Executive Officer") == 1
    assert role_priority("President") == 2


def test_specific_titles_rank_correctly():
    assert role_priority("Chief Financial Officer and Secretary") == 5  # CFO beats Secretary
    assert role_priority("Chairman of the Board") == 4
    assert role_priority("Chief Executive Officer") == 1
    assert role_priority("Director") == 10
    assert role_priority("") == 99
    assert role_priority("Grand Poobah") == 99


def test_normalize_role():
    assert normalize_role("President & CEO") == "president and ceo"
    assert normalize_role("Chief   Executive  Officer.") == "chief executive officer"


def test_looks_like_role():
    assert looks_like_role("Chief Executive Officer")
    assert looks_like_role("Director")
    assert not looks_like_role("52")
    assert not looks_like_role("Delaware")
