"""Optional OpenAI augmentation for the pipeline.

Two jobs the heuristics are weak at:
  * extract_officers — pull (name, role) pairs from messy filing HTML when the
    table/signature heuristics return nothing.
  * resolve_domain — infer a company's real web domain from its name, used by
    Layer 4 (and always validated against a live homepage before we trust it,
    so a hallucinated domain is discarded).

The module is import-safe without the ``openai`` package or an API key:
``is_configured()`` returns False and callers fall back to heuristics. An LLM
is NEVER used to claim an email is deliverable — that is not something it can
verify.
"""

from __future__ import annotations

import json

from config import (
    OPENAI_API_KEY,
    OPENAI_MAX_HTML_CHARS,
    OPENAI_MODEL,
    OPENAI_TIMEOUT,
)

try:
    from bs4 import BeautifulSoup
except Exception:  # noqa: BLE001
    BeautifulSoup = None


def is_configured() -> bool:
    if not OPENAI_API_KEY:
        return False
    try:
        import openai  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT)


def _html_to_text(html: str) -> str:
    if BeautifulSoup is None:
        text = html
    else:
        text = BeautifulSoup(html, "html.parser").get_text("\n")
    return text[:OPENAI_MAX_HTML_CHARS]


async def _chat_json(system: str, user: str) -> dict | list | None:
    """One JSON-mode chat completion. Returns parsed JSON or None on any failure."""
    try:
        client = _client()
        resp = await client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return json.loads(resp.choices[0].message.content)
    except Exception:  # noqa: BLE001 — caller falls back to heuristics
        return None


async def extract_officers(html: str, source_type: str) -> list[dict]:
    """Return a list of ``{"name": ..., "role": ...}`` from filing HTML."""
    text = _html_to_text(html)
    system = (
        "You extract executive officers and directors from SEC filing text. "
        "Return STRICT JSON: {\"officers\": [{\"name\": \"First Last\", "
        "\"role\": \"Chief Executive Officer\"}]}. Only real human individuals "
        "named as directors/officers/management. Exclude company names, law "
        "firms, auditors, placement agents, states, and addresses. If none are "
        "present, return {\"officers\": []}."
    )
    data = await _chat_json(system, text)
    if isinstance(data, dict):
        officers = data.get("officers", [])
        return [o for o in officers if isinstance(o, dict) and o.get("name")]
    return []


async def resolve_domain(company_name: str) -> str | None:
    """Infer the most likely primary web domain for a company, or None.

    The result MUST be validated against a live homepage by the caller; this is
    a hint, not a fact.
    """
    system = (
        "You map a company's legal name to its most likely primary website "
        "domain (the marketing site, not a stock-ticker page). Return STRICT "
        "JSON: {\"domain\": \"example.com\"} with just the registrable domain, "
        "no scheme or path. If you are not reasonably confident, return "
        "{\"domain\": null}."
    )
    data = await _chat_json(system, f"Company: {company_name}")
    if isinstance(data, dict):
        dom = data.get("domain")
        if isinstance(dom, str) and "." in dom:
            return dom.strip().lower().lstrip("https://").lstrip("http://").strip("/")
    return None
