"""A single shared async token-bucket rate limiter.

All SEC requests across every phase and worker pass through one instance so the
combined rate stays under the SEC ceiling (brief §10: 10 req/s; we target 5).
"""

from __future__ import annotations

import asyncio
import time


class RateLimiter:
    """Token bucket. ``acquire()`` blocks until a token is available.

    Tokens refill continuously at ``rate`` per second up to a burst of ``rate``.
    Shared across coroutines via an internal lock, so N workers self-throttle to
    the global budget rather than each running at ``rate``.
    """

    def __init__(self, rate: float):
        self.rate = float(rate)
        self.capacity = float(rate)
        self._tokens = float(rate)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(
                    self.capacity, self._tokens + (now - self._last) * self.rate
                )
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                # Not enough; sleep for the time to accrue one token.
                await asyncio.sleep((1.0 - self._tokens) / self.rate)
