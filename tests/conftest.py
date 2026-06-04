"""Shared pytest fixtures and path setup.

Adds the project root to ``sys.path`` so tests can ``import config`` and
``import msc_edgar`` without an editable install, and exposes the fixtures dir.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture
def tmp_db(tmp_path):
    """A freshly initialised SQLite database in a temp dir."""
    from msc_edgar.db import init_db

    return init_db(tmp_path / "test.sqlite3")
