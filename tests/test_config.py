"""Phase 0 acceptance: config invariants the rest of the pipeline relies on."""

import config


def test_user_agent_has_contact_email():
    # SEC blocks requests without a real contact email in the UA (brief §10).
    assert "@" in config.USER_AGENT and "." in config.USER_AGENT.split("@")[1]


def test_rate_limit_under_sec_ceiling():
    assert 0 < config.REQUESTS_PER_SECOND <= 10


def test_all_four_regulations_present():
    assert set(config.REGULATION_FORMS) == {"A+", "D", "S", "144A"}
    assert config.REGULATION_FORMS["D"] == ["D"]


def test_ceo_outranks_president():
    # "president and ceo" must resolve to the CEO priority, not President.
    assert config.OFFICER_ROLE_PRIORITY["president and ceo"] < \
        config.OFFICER_ROLE_PRIORITY["president"]


def test_email_patterns_use_known_placeholders():
    allowed = {"first", "last", "f", "l"}
    import string

    for pat in config.EMAIL_PATTERNS:
        fields = {name for _, name, _, _ in string.Formatter().parse(pat) if name}
        assert fields <= allowed, f"unexpected placeholder in {pat!r}"


def test_historical_start_is_2022():
    assert config.HISTORICAL_START.year == 2022
