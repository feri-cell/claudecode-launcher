"""Officer role normalization and ranking (brief §3d).

A single normalized-substring matcher maps any free-text role to a seniority
priority (lower = more senior). Keys are matched **longest-first** so
"President and CEO" resolves to CEO (1), never President (2) — the founder-CEO
under-ranking trap called out in the brief.
"""

from __future__ import annotations

import re

from config import OFFICER_ROLE_PRIORITY, ROLE_PRIORITY_UNKNOWN

# Role keywords precomputed longest-first for substring matching.
_ROLE_KEYS = sorted(OFFICER_ROLE_PRIORITY, key=len, reverse=True)

# Any of these keyword stems makes a text cell look like a role/title.
ROLE_HINTS = (
    "chief", "officer", "president", "ceo", "cfo", "coo", "cto", "director",
    "chairman", "chairperson", "chair", "founder", "secretary", "treasurer",
    "general counsel", "managing member", "manager", "partner", "principal",
    "vice president", "vp", "trustee", "executive",
)


def normalize_role(role: str) -> str:
    """Lowercase, expand ``&`` to ``and``, strip punctuation, collapse spaces."""
    if not role:
        return ""
    s = role.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def role_priority(role: str) -> int:
    """Map a role string to its seniority priority (lower = more senior)."""
    norm = normalize_role(role)
    if not norm:
        return ROLE_PRIORITY_UNKNOWN
    for key in _ROLE_KEYS:          # longest key first
        if key in norm:
            return OFFICER_ROLE_PRIORITY[key]
    return ROLE_PRIORITY_UNKNOWN


def looks_like_role(text: str) -> bool:
    """True if a text cell plausibly describes a title/role."""
    norm = normalize_role(text)
    return any(h in norm for h in ROLE_HINTS)
