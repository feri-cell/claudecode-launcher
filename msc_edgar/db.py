"""SQLite access for the pipeline.

Schema creation is synchronous (stdlib ``sqlite3``) so setup and tests stay
simple; the long-running pipeline phases open async connections via
``aiosqlite``. Both point at the same file and schema.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import DB_PATH

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def utcnow_iso() -> str:
    """ISO-8601 UTC timestamp used for every ``*_at`` column."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_schema() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8")


def init_db(path: Path | str = DB_PATH) -> Path:
    """Create the database file and all tables if they do not yet exist.

    Idempotent: every statement uses ``IF NOT EXISTS``. Returns the db path.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(_read_schema())
        conn.commit()
    finally:
        conn.close()
    return path


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    """Open a synchronous connection with sane defaults (row access by name)."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


async def aconnect(path: Path | str = DB_PATH):
    """Open an async connection for the pipeline workers.

    Imported lazily so that ``init_db`` / tests do not require ``aiosqlite``.
    """
    import aiosqlite

    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def table_names(path: Path | str = DB_PATH) -> set[str]:
    """Return the set of user table names — handy for tests and sanity checks."""
    conn = connect(path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return {r["name"] for r in rows}
    finally:
        conn.close()


if __name__ == "__main__":  # `python -m msc_edgar.db` initialises the database
    p = init_db()
    print(f"Initialised database at {p}")
    print("Tables:", ", ".join(sorted(table_names(p))))
