"""Shared async HTTP client for all SEC endpoints.

Responsibilities:
  * attach the compliant User-Agent on every request (brief §10),
  * funnel every call through one rate limiter,
  * retry transient failures (429 / 5xx / network) with capped backoff,
  * record each fetch to the ``fetch_log`` table for observability.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

import httpx

from config import (
    DB_PATH,
    MAX_RETRIES,
    REQUESTS_PER_SECOND,
    RETRY_BACKOFF,
    USER_AGENT,
)
from msc_edgar.db import utcnow_iso
from msc_edgar.ratelimit import RateLimiter

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class SecClient:
    """Async context-managed SEC HTTP client.

    Usage::

        async with SecClient() as sec:
            data = await sec.get_json(url, params=...)
    """

    def __init__(self, rate: float = REQUESTS_PER_SECOND, db_path: Path | str = DB_PATH):
        self._limiter = RateLimiter(rate)
        self._db_path = Path(db_path)
        self._client = httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
            http2=True,
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
        )

    async def __aenter__(self) -> "SecClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    # -- logging ---------------------------------------------------------- #
    def _log_sync(self, url, status, ok, ms, error):
        try:
            conn = sqlite3.connect(self._db_path, timeout=5)
            conn.execute(
                "INSERT INTO fetch_log (url, status_code, ok, duration_ms, error, fetched_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (url[:500], status, 1 if ok else 0, ms, error, utcnow_iso()),
            )
            conn.commit()
            conn.close()
        except sqlite3.Error:
            pass  # observability must never break the pipeline

    async def _log(self, url, status, ok, ms, error=None):
        await asyncio.to_thread(self._log_sync, url, status, ok, ms, error)

    # -- core fetch ------------------------------------------------------- #
    async def _fetch(self, url: str, params: dict | None = None) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            await self._limiter.acquire()
            t0 = time.monotonic()
            try:
                resp = await self._client.get(url, params=params)
                ms = int((time.monotonic() - t0) * 1000)
            except httpx.HTTPError as exc:
                ms = int((time.monotonic() - t0) * 1000)
                await self._log(url, None, False, ms, repr(exc))
                last_exc = exc
            else:
                if resp.status_code in RETRYABLE_STATUS:
                    await self._log(str(resp.url), resp.status_code, False, ms,
                                    f"retryable {resp.status_code}")
                    last_exc = httpx.HTTPStatusError(
                        f"retryable {resp.status_code}", request=resp.request, response=resp
                    )
                else:
                    await self._log(str(resp.url), resp.status_code,
                                    resp.is_success, ms, None)
                    resp.raise_for_status()
                    return resp
            # backoff before next attempt
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                await asyncio.sleep(delay)
        assert last_exc is not None
        raise last_exc

    async def get_json(self, url: str, params: dict | None = None):
        resp = await self._fetch(url, params)
        return resp.json()

    async def get_text(self, url: str, params: dict | None = None) -> str:
        resp = await self._fetch(url, params)
        return resp.text

    async def get_bytes(self, url: str, params: dict | None = None) -> bytes:
        resp = await self._fetch(url, params)
        return resp.content
