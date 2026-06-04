# MSC EDGAR — Custom Enrichment System

**Status brief and build plan for the SEC outreach platform**
*Manhattan Street Capital · Author: Feri · Hand-off target: Claude Code*

---

## 1. Executive summary (for Rod)

We already collect SEC filings (Reg A+, Reg D, Reg S, Rule 144A) from the EDGAR public API every day and load them into the MSC Outreach dashboard. That part works.

**What's missing is the enrichment layer** — turning a filing into a usable outreach contact (CEO name, role, company website, email address). Today every row in the dashboard has a company name and not much else.

This document specifies the system that replaces Hunter.io with our own enrichment built on free, public SEC data plus a small email-finding layer. When finished, every Reg A+ / Reg D / Reg S / Rule 144A filing will arrive in the dashboard with up to three named decision-makers, their roles, the company's real website, and candidate email addresses we can verify and send to. No third-party contact-data vendor needed.

---

## 2. What exists today

### 2.1 Working pieces

| Component | State | Notes |
|---|---|---|
| **MSC Outreach dashboard** (`msc-v7.html`) | ✅ Working | 2,119-line single-page app. Parses CSVs in 2,000-row chunks. Has list management, regulation filters, search, email-sequence editor, GPT prompt panel. Persists contacts across re-imports. |
| **EDGAR filing discovery** | ✅ Working | Some existing Python script pulls 26,207 filings (2023–2026) across all four regulations from the EDGAR public API. The dashboard ingests this CSV cleanly. |
| **CSV → dashboard ingestion** | ✅ Working | Dashboard column mapper (`COL` object) maps case-insensitive column names: `Company Name`, `CIK`, `Regulation`, `Form Type`, `Filing Date`, `First Name`, `Last Name`, `Role`, `Email`, `Guessed Email`, `EDGAR URL`, `Source`. |
| **Outreach UI** | ✅ Working | Named lists, sequence templates per regulation, email-status tracking, draft-by-prompt panel — all functional once contacts have data. |

### 2.2 Known broken pieces (visible in the current CSV)

Inspected `edgar_filings.csv` (26,207 rows). Findings:

| Problem | Severity | Evidence |
|---|---|---|
| **`First Name`, `Last Name`, `Role`, `Email` are 0% populated** | 🔴 Critical | Zero rows out of 26,207 have any of these fields. The dashboard renders blank contacts. |
| **CIK column is wrong** | 🔴 Critical | Same CIK `1104659` appears across TerraCycle, Portola Walnut JV, Aurora Mobile Ltd, Eagle Nuclear — four unrelated companies. The current script is grabbing the **filer agent's CIK** (first segment of the accession number) instead of the **issuer's CIK** (`_source.ciks[0]` in the EFTS API). |
| **Company Name has trailing `(CIK 000…)` suffix** | 🟠 Cosmetic but spreads | E.g. `TerraCycle US Inc.  (CIK 0001714781)`. Pollutes search and email templates. |
| **Website is fabricated** | 🔴 Critical | 72% of rows (18,842 of 26,207) have `Website Source: guess`. Pattern is `https://{slug}cik{padded_cik}.com` — not a real domain. The remaining 28% labeled `verified` need spot-checking. |
| **EDGAR URL uses the wrong CIK** | 🟠 Useful but misleading | Every URL points at the filer-agent CIK, so clicking the link in the dashboard takes you to the wrong company's filings page. |
| **Missing 2022 data** | 🟡 Coverage gap | Rows cover 2023–2026 only. Project scope is 2022→today. |

### 2.3 What this means

The current Python script does **discovery only** — it lists filings. Everything beyond a company name is either missing or fake. The dashboard works fine; it just has nothing real to display in the contact columns.

---

## 3. What we're building

A four-layer pipeline that takes a filing and produces a usable outreach record:

```
   ┌────────────────────────────────────────────────────────────────┐
   │ Layer 1 — DISCOVERY  (already partially working)               │
   │   • Query EFTS for new filings per regulation × year           │
   │   • Output: accession number + correct issuer CIK              │
   └────────────────────────────────────────────────────────────────┘
                                  ↓
   ┌────────────────────────────────────────────────────────────────┐
   │ Layer 2 — COMPANY ENRICHMENT  (new)                            │
   │   • Fetch data.sec.gov/submissions/CIK{cik}.json               │
   │   • Output: clean name, real website, SIC, state of inc.       │
   └────────────────────────────────────────────────────────────────┘
                                  ↓
   ┌────────────────────────────────────────────────────────────────┐
   │ Layer 3 — OFFICER EXTRACTION  (new)                            │
   │   • Form D → parse primary_doc.xml <relatedPersonsList>        │
   │   • 1-A / 253G → parse HTML "Directors & Executive Officers"   │
   │   • S-1 / S-3 / F-1 / F-3 / F-4 → parse HTML mgmt + signatures │
   │   • Rank by role priority, take top 3                          │
   │   • Output: first, last, role per officer                      │
   └────────────────────────────────────────────────────────────────┘
                                  ↓
   ┌────────────────────────────────────────────────────────────────┐
   │ Layer 4 — EMAIL FINDING  (new — the Hunter.io replacement)     │
   │   • Generate candidate patterns at company domain              │
   │   • Verify via MX + SMTP RCPT TO probe                         │
   │   • Optional: scrape company /about, /team, /contact pages     │
   │   • Output: best email + verification status + guessed alts    │
   └────────────────────────────────────────────────────────────────┘
                                  ↓
                  CSV export → MSC Outreach dashboard
```

Each layer is independently testable, independently re-runnable, and writes its result to SQLite so we never lose progress.

---

## 4. Why this beats Hunter.io for our use case

| Concern | Hunter.io | Custom system |
|---|---|---|
| **Cost** | $49–$499/mo, capped requests | $0 + a small SMTP verification budget if we use one |
| **Coverage of SEC filers** | Patchy — most just-filed Reg D shell entities aren't in Hunter at all | Direct from the filing — we get every officer the issuer disclosed |
| **Source of officer name** | Web scraping + LinkedIn + their proprietary db | **Sworn statements on Form D / signature pages** — legally accurate |
| **Freshness** | Whatever Hunter last crawled | Same day as the SEC filing |
| **Data ownership** | Theirs (rate-limited API) | Ours (SQLite + CSV) |
| **Auditability** | "Hunter says…" | We can point at the exact line in the SEC filing |

The one thing Hunter does better is *email confidence scoring* — they have a billion verified addresses to compare against. We compensate by combining pattern generation + SMTP verification + optional scraping. For our volumes (a few hundred new filings per week) this is the right trade.

---

## 5. Data sources (every URL, no guessing)

All endpoints below are **free, public, no API key**. SEC requires a real User-Agent header with a contact email — see §10.

### 5.1 Filing discovery — EFTS

```
GET https://efts.sec.gov/LATEST/search-index
    ?forms={form_type}
    &dateRange=custom
    &startdt={YYYY-MM-DD}
    &enddt={YYYY-MM-DD}
    &from={offset}
    &size=100
```

Returns JSON. Each hit looks like:

```json
{
  "_id": "0001493152-26-016607",                  // ← accession number, NOT a CIK
  "_source": {
    "ciks":          ["0001714781", "0001493152"],// ← [0] is the ISSUER; rest are filers/agents
    "display_names": ["TerraCycle US Inc. (CIK 0001714781)"],
    "form":          "1-A",
    "file_date":     "2026-03-20",
    "adsh":          "0001493152-26-016607"
  }
}
```

**Critical**: The issuer CIK is `_source.ciks[0]`. Do not parse the accession number — its first segment is the filer agent's CIK, which is what's wrong in the current CSV. Also strip the trailing ` (CIK …)` from `display_names[0]` before storing.

EFTS caps any single query at 10,000 results. Chunk by year (and by month if a year is still over the cap) to stay under it.

### 5.2 Company metadata — Submissions JSON

```
GET https://data.sec.gov/submissions/CIK{cik_padded_to_10}.json
```

Returns the canonical record for one company:

```json
{
  "name":                  "TerraCycle US Inc.",
  "sic":                   "5040",
  "sicDescription":        "Professional & Commercial Equipment",
  "stateOfIncorporation":  "DE",
  "website":               "https://www.terracycle.com",   // ← when filer provided one
  "tickers":               [],
  "exchanges":             [],
  "addresses":             { ... }
}
```

`website` is present on roughly 30–50% of issuers (the ones who bothered to include it in their EDGAR registration). When absent → we fall back to officer-name + company-name web search or manual review.

### 5.3 Filing documents — Archives

```
# Folder containing all documents in one filing
GET https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/

# Machine-readable index of every document in the filing
GET https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/index.json

# Form D structured data
GET https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/primary_doc.xml

# Filed HTML body (for 1-A, S-1, S-3, F-1, F-3, F-4)
GET https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/{primary_htm_file}
```

`{cik_no_zeros}` = integer form, no leading zeros (e.g. `1714781`, not `0001714781`).
`{accession_no_dashes}` = the accession number with dashes stripped (e.g. `000149315226016607`).

---

## 6. CSV output schema (locked to the v7 dashboard)

The dashboard's `COL` object in `msc-v7.html` (lines 1117–1132) recognizes these column names — case-insensitive. **Do not rename them.** Order is flexible but spelling matters.

| Column | Type | Notes |
|---|---|---|
| `Regulation` | `A+` / `D` / `S` / `144A` | Dashboard normalizes both `Reg A+` and `A+`, but emit `A+` directly. |
| `Form Type` | string | `1-A`, `D`, `S-1`, `F-3`, etc. — exactly as in EFTS. |
| `Company Name` | string | **Clean name with `(CIK …)` suffix stripped.** |
| `CIK` | integer | **Issuer CIK from `_source.ciks[0]`, leading zeros stripped.** |
| `First Name` | string | Officer 1's first name. Empty if extraction failed. |
| `Last Name` | string | Officer 1's last name. |
| `Role` | string | Officer 1's role (e.g. `Chief Executive Officer`). |
| `Email` | string | Verified email if SMTP probe returned 250/2.x.x. Otherwise blank. |
| `Guessed Email` | string | Best pattern guess (`first.last@domain`) if `Email` is blank. Dashboard flags this with `email_verified: false`. |
| `Filing Date` | `YYYY-MM-DD` | From `_source.file_date`. |
| `Year` | int | Convenience field. |
| `Status` | string | `filed`, `qualified`, `withdrawn`, `active` — derived per form type. |
| `Website` | string | **Real URL from submissions JSON, not a guess.** |
| `Website Source` | `verified` / `unknown` | Drop `guess` entirely. If we don't have it, leave Website blank and set source to `unknown`. |
| `EDGAR URL` | string | `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={issuer_cik}&type=&dateb=&owner=include&count=40` |
| `Source` | string | Always `edgar` for this pipeline. |

**Officer overflow.** For companies where we extract more than one decision-maker, emit one row per (filing × top-3-officer). Officer rank 1 (highest priority — typically CEO) goes first. The dashboard de-dupes by `(CIK, Regulation, Filing Date)` so additional officer rows for the same filing get merged into the contact record via the `ck_key(cik, reg)` index.

---

## 7. Build plan — phase by phase

Each phase ships independently. Don't build phase N+1 until phase N is in the dashboard and looking right.

### Phase 0 — Project scaffold (2 hours)

- Python 3.12+ project, `venv`, `requirements.txt`
- Dependencies: `httpx[http2]`, `aiosqlite`, `lxml`, `beautifulsoup4`, `tenacity`, `python-dateutil`, `dnspython`
- SQLite schema with these tables:
  - `companies (cik PK, name, website, website_source, sic, state, first_seen_at, last_updated_at, status)`
  - `filings (accession PK, cik FK, regulation, form_type, filing_date, primary_doc, status, retry_count, last_error)`
  - `officers (id PK, cik FK, full_name, first, last, role, role_priority, source_accession, source_type, rank, is_top_3)`
  - `emails (id PK, cik FK, officer_id FK, address, pattern, verification_status, verified_at, response_code)`
  - `retry_queue`, `checkpoints`, `fetch_log` (for resumability + observability)
- Single config file with: `USER_AGENT`, `RATE_LIMIT=5 req/sec`, `MAX_RETRIES=5`, `DATE_RANGE=2022→today`
- Test fixture folder with one known-good Form D XML, one known-good 1-A HTML, one S-1 HTML

**Acceptance**: `python -m pytest` runs, SQLite tables created, fixtures committed.

### Phase 1 — Fix discovery (1 day)

Replace the existing fetcher. The new version must:

1. Loop over `REGULATION → [forms]`:
   - `A+`: `1-A`, `1-A/A`, `253G1`, `253G2`, `253G3`, `253G4`
   - `D`: `D`
   - `S`: `F-1`, `F-1/A`, `F-3`, `F-3/A`
   - `144A`: `S-1`, `S-1/A`, `S-3`, `S-3/A`, `F-4`, `F-4/A`
2. For each (regulation, form, year) tuple from 2022→today: page through EFTS at 100 hits/request, stop at `total` or 10,000.
3. **Extract the issuer CIK from `_source.ciks[0]`, not from the accession number.** Strip leading zeros for display, pad to 10 digits for URLs.
4. Clean the display name: split on ` (CIK ` and keep the left side.
5. Write rows to `companies` (upsert by CIK) and `filings` (insert ignore on accession).
6. Checkpoint per (regulation, year) so a crash resumes cleanly.

**Acceptance test:** Pick three known issuers (TerraCycle, Aurora Mobile, Eagle Nuclear from the current CSV). Confirm each gets the right distinct CIK, not the shared filer-agent CIK 1104659.

### Phase 2 — Company enrichment (½ day)

For every distinct CIK seen in phase 1:

1. Fetch `data.sec.gov/submissions/CIK{cik_padded}.json`.
2. Upsert into `companies` with: `name` (overwrite — the submissions JSON is canonical), `website`, `sic`, `sicDescription`, `stateOfIncorporation`.
3. If `website` is present and non-empty → `website_source = 'verified'`. Otherwise leave blank, set `website_source = 'unknown'`. **Do not pattern-generate URLs.**
4. Rate-limit at 5 req/sec total across all phases (token bucket, shared).

**Acceptance test:** Spot-check 20 random rows in the dashboard. Every `Website` field must be either blank or a real working URL. Zero `https://{slug}cik{number}.com` patterns.

### Phase 3 — Officer extraction (2 days)

The decision-maker layer. Three parsers, one router.

#### 3a. Form D parser (XML — easy, high yield)

Form D is the *majority* of our data — 25,907 of 26,207 rows. It's also the only form type with structured XML, so this is the highest-leverage parser.

```
GET https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dashes}/primary_doc.xml
```

XPath structure (namespace-tolerant — use `local-name()`):

```xml
<edgarSubmission>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Jane</firstName>
        <middleName>R</middleName>      <!-- optional -->
        <lastName>Smith</lastName>
      </relatedPersonName>
      <relatedPersonRelationshipList>
        <relationshipList>
          <relationship>Executive Officer</relationship>
          <relationship>Director</relationship>
        </relationshipList>
      </relatedPersonRelationshipList>
      <relationshipClarification>Chief Executive Officer</relationshipClarification>
    </relatedPersonInfo>
    <!-- repeated per person -->
  </relatedPersonsList>
</edgarSubmission>
```

**Pitfall I hit on the prior build**: use `.//*[local-name()=$tag]` (relative XPath, scoped to the context node) inside the per-person loop, NOT `//*[local-name()=$tag]`. The absolute form returns matches from the entire document on every iteration and you get the first person's data duplicated for every person. Test this with a fixture containing two distinct officers and assert the parser returns two distinct full names.

#### 3b. 1-A / 253G HTML parser

Reg A+ filings have an Item 10 section titled "Directors, Executive Officers and Significant Employees" — almost always as a table:

```html
<table>
  <tr><th>Name</th><th>Age</th><th>Position</th></tr>
  <tr><td>Jane Smith</td><td>52</td><td>Chief Executive Officer</td></tr>
  <tr><td>John Doe</td><td>48</td><td>Chief Financial Officer</td></tr>
</table>
```

Strategy: use BeautifulSoup. For every `<table>`, look at every `<tr>`. Find a cell that looks like a person name (`/^[A-Z][a-z]+(\s+[A-Z]\.?)?\s+[A-Z][a-z]+/`) and another cell containing a role keyword. Pair them.

Also scan signature pages (usually at the end of the filing) for `Name, Role` patterns like `Jane Smith, Chief Executive Officer` — catches officers who weren't in the management table.

**Reject false positives**: city names ("Delaware", "Nevada"), corporate forms ("Inc", "LLC", "Corporation"). Any "name" that's a single token or contains those keywords gets dropped.

#### 3c. S/F-series HTML parser

Same strategy as 1-A but the target section is "Management" or "Executive Officers and Directors". Same table heuristics work — the prose just varies.

#### 3d. Officer ranker

```
priority lookup (lower = more senior):
  1  CEO / Chief Executive Officer / President & CEO
  2  President
  3  Founder / Co-Founder
  4  Chairman / Chair
  5  CFO / Chief Financial Officer
  6  COO / Chief Operating Officer
  7  General Counsel / Chief Legal Officer
  8  Secretary
  9  Executive Officer (generic)
  10 Director
  99 unknown
```

Match against the *normalized* role string (lowercase, punctuation stripped, whitespace collapsed). Use **substring matching ordered by length** so "President and CEO" picks up the CEO priority (1), not the President priority (2). Critical for not under-ranking founder-CEOs.

After every parse, recompute the top 3 for that company: order by `role_priority ASC, source_filing_date DESC` and flag the top 3 as `is_top_3 = 1`.

**Acceptance test:** Pick 5 Form D filings with known CEOs (any large recent raise), 5 1-A filings, 5 S-1 filings. Run extraction. Manually compare the top-1 officer to what the filing actually says. Goal: ≥90% match rate on Form D, ≥75% on HTML forms.

### Phase 4 — Email finding (3–5 days, the meaty part)

The actual Hunter.io replacement. Three sub-stages.

#### 4a. Domain resolution

Already done in Phase 2 if the issuer disclosed a website. When they didn't:

- Try the company name as a domain heuristic: strip "Inc", "LLC", "Corp", "Ltd", "Holdings"; lowercase; remove spaces and punctuation; try `.com` first. e.g. "TerraCycle US Inc." → `terracycle.com`.
- Validate by fetching the homepage with httpx and confirming a 200 + an HTML title.
- If that fails, the domain is `unknown` — we still emit a guessed email below but flag it `verified=false, domain_verified=false`.

This step is best-effort. It's better to leave the email blank than to fabricate a domain.

#### 4b. Pattern generation

For each top-3 officer with a known company domain, generate candidate addresses. The eight industry-standard patterns, in order of empirical frequency:

```
1.  {first}.{last}@domain         jane.smith@acme.com
2.  {first}@domain                jane@acme.com
3.  {f}{last}@domain              jsmith@acme.com
4.  {first}_{last}@domain         jane_smith@acme.com
5.  {first}{last}@domain          janesmith@acme.com
6.  {last}@domain                 smith@acme.com
7.  {first}{l}@domain             janes@acme.com
8.  {f}.{last}@domain             j.smith@acme.com
```

All lowercase, ASCII-folded (`José` → `jose`).

#### 4c. Verification

This is where the rubber meets the road. Three options, listed cheapest first:

**Option A — DNS + SMTP probe (free, ~70% reliable)**

```python
# Pseudocode
import dns.resolver, smtplib
mx_records = dns.resolver.resolve(domain, 'MX')
mx_host = sorted(mx_records, key=lambda r: r.preference)[0].exchange.to_text()

with smtplib.SMTP(mx_host, timeout=10) as s:
    s.helo('manhattanstreetcapital.com')
    s.mail('outreach@manhattanstreetcapital.com')
    code, _ = s.rcpt(candidate_address)
    # 250 = exists, 550 = doesn't, anything else = inconclusive
```

Issues with SMTP probing:
- Some servers (Gmail, Outlook 365) always answer 250 regardless — "catch-all" behavior. Detect by probing a known-bad address first (`zzzzzzzz@domain`); if that also returns 250, the server is catch-all and you can't trust the result.
- ISPs increasingly throttle or block port-25 outbound from cloud IPs. Run from MSC's office IP or a residential VPS.
- Aggressive probing gets us flagged as a spammer. Cap at **30 probes per domain per day**, sleep 5–10s between probes.

**Option B — Paid verification API (cheap, more reliable)**

Services that do this professionally for $0.001–$0.01 per check:
- **NeverBounce** (~$0.008/check, good catch-all detection)
- **ZeroBounce** (~$0.008/check, includes role-address flagging)
- **MillionVerifier** (~$0.004/check, EU-based)

For our volume (a few hundred new filings/week × 3 officers × 8 patterns = ~5,000–10,000 verifications/month), paid verification costs $40–$80/month — still 1/10th of Hunter.io and we keep ownership of the address list.

**Recommendation: do Option A for free coverage, fall back to Option B for high-value targets** (Reg A+ specifically — small list, big offerings, worth getting right).

**Option C — Scrape company sites (free, low yield, occasional gold)**

For each company website, fetch and parse `/about`, `/team`, `/contact`, `/leadership`. Look for:
- `mailto:` links → high confidence
- Plain-text email patterns matching the officer's name → medium confidence

Smaller issuers sometimes post the CEO's email directly. Larger ones don't. Yield is ~10–15% but the matches are gold-standard.

#### 4d. Storing results

Per (officer × pattern) attempt, write a row to `emails` with:
- `address` (the candidate)
- `pattern` (which template generated it)
- `verification_status`: `verified` / `unverified` / `catchall` / `rejected` / `not_attempted`
- `response_code` (raw SMTP code or API response)
- `verified_at` timestamp

For the CSV export, pick the highest-confidence email per officer:
- `Email` column ← address with status=`verified`
- `Guessed Email` column ← best unverified candidate (pattern #1 first, then #2, etc.)

The dashboard (`msc-v7.html` line 1213–1222) already distinguishes these via `email_verified` flag.

**Acceptance test:** Run the full pipeline on 50 random Reg A+ filings. Manual spot-check: for each, can a human confirm the email actually reaches the CEO? Target: ≥40% verified, ≥80% with a plausible guess.

### Phase 5 — Orchestration & schedule (½ day)

- One FastAPI app on `127.0.0.1:{port}` with a small monitoring UI (live progress, log tail, CSV export button — can reuse the dashboard I built earlier or build a thin version).
- Daily cron at 03:00 local: run incremental discovery for `today - 2 days → today`, then enrichment, then officer extraction, then email finding for newly-extracted officers. The 2-day overlap catches late-posted filings.
- CSV export endpoint: `GET /api/export/csv` writes to `data/edgar_filings.csv` (overwrite each run) and offers a browser download. Keep the column names exactly as in §6.
- Resumability: every phase reads its starting point from `checkpoints` and writes progress markers as it goes. Crash → restart → continue.

---

## 8. Configuration reference

Drop these in `config.py`:

```python
USER_AGENT = "Manhattan Street Capital feri@manhattanstreetcapital.com"
# SEC requires a real contact email in the UA. They will block requests without one.

REQUESTS_PER_SECOND = 5.0     # SEC ceiling is 10. We target 5 for headroom.
WORKER_COUNT        = 3        # async workers sharing the rate budget
MAX_RETRIES         = 5
RETRY_BACKOFF       = [1, 5, 30, 120, 600]  # seconds

HISTORICAL_START = date(2022, 1, 1)
DAILY_RUN_HOUR   = 3            # 03:00 local

REGULATION_FORMS = {
    "A+":   ["1-A", "1-A/A", "253G1", "253G2", "253G3", "253G4"],
    "D":    ["D"],
    "S":    ["F-1", "F-1/A", "F-3", "F-3/A"],
    "144A": ["S-1", "S-1/A", "S-3", "S-3/A", "F-4", "F-4/A"],
}

OFFICER_ROLE_PRIORITY = {
    "chief executive officer": 1, "ceo": 1, "president and ceo": 1,
    "president": 2,
    "founder": 3, "co-founder": 3,
    "chairman": 4, "chairperson": 4,
    "chief financial officer": 5, "cfo": 5,
    "chief operating officer": 6, "coo": 6,
    "general counsel": 7, "chief legal officer": 7,
    "secretary": 8,
    "executive officer": 9,
    "director": 10,
}

EMAIL_PATTERNS = [
    "{first}.{last}", "{first}", "{f}{last}", "{first}_{last}",
    "{first}{last}", "{last}", "{first}{l}", "{f}.{last}",
]

SMTP_VERIFICATION_HELO_DOMAIN = "manhattanstreetcapital.com"
SMTP_VERIFICATION_MAIL_FROM   = "outreach@manhattanstreetcapital.com"
SMTP_PROBE_TIMEOUT            = 10        # seconds
SMTP_PROBES_PER_DOMAIN_PER_DAY = 30
SMTP_SLEEP_BETWEEN_PROBES      = 7         # seconds
```

---

## 9. Edge cases and how to handle them

| Case | Handling |
|---|---|
| Form D filed by a fund-of-funds / SPV with no real "officers" — just the manager LLC | Extract anyway; the manager LLC's executives become the contact. Flag `is_spv=1` so we can filter later if needed. |
| Foreign issuer (e.g. F-3) with no US website | `website` = blank, `website_source` = `unknown`. Skip email generation; emit officer row with empty Email and Guessed Email. |
| Issuer whose website resolves but the domain has no MX record | Same as above. Don't probe SMTP. |
| Catch-all SMTP server | Mark all candidates `verification_status='catchall'`. Pick pattern #1 as Guessed Email. Flag the CSV row so outreach treats these with extra caution. |
| Person with one-token name (legal entity instead of human) | Skip — almost certainly an entity, not a contact. |
| Two CIKs for what looks like the same company (M&A, reorganization) | Treat as distinct. They have different filings and almost certainly different contacts. |
| HTML parsing returns 0 officers | Mark filing `status='incomplete'`, enqueue for retry. After `MAX_RETRIES` give up and leave the filing in the CSV with company info only. The CEO can still see the filing exists. |
| Submissions JSON returns 404 | Rare but happens for very new CIKs. Retry queue. After max retries, leave website blank. |
| Rate limit (HTTP 429) from EDGAR | Token bucket should prevent this. If it happens anyway, exponential backoff up to 10 minutes. Persistent 429s usually mean someone else on our IP is hammering EDGAR — check shared infrastructure. |

---

## 10. SEC compliance requirements

Non-negotiable:

1. **User-Agent header on every request** containing the company name and a real contact email. Example: `Manhattan Street Capital feri@manhattanstreetcapital.com`. Requests without this get blocked. The SEC publishes this requirement at https://www.sec.gov/os/accessing-edgar-data.
2. **Rate limit** of 10 requests per second per User-Agent across all EDGAR endpoints combined. We target 5 to be polite.
3. **Use HTTPS** for all EDGAR endpoints (not HTTP).
4. **No CAPTCHA bypass, no scraping behind login.** Everything we need is on the public endpoints.

---

## 11. Testing & acceptance criteria

The system is "done" when all of these are true:

- [ ] Pull 2022→today completes without manual intervention; checkpoints survive a Ctrl-C and resume.
- [ ] CSV export loads cleanly into `msc-v7.html` (drag-drop or Import CSV button) with no parse errors.
- [ ] On a random sample of 20 rows, manually verify:
  - [ ] Company name is clean (no `(CIK …)` suffix)
  - [ ] CIK is correct (matches the CIK shown on the SEC's company page for that name)
  - [ ] Website, when populated, is a real URL that loads
  - [ ] At least one officer name is populated and matches the actual filing
  - [ ] Role is reasonable (CEO, CFO, Director — not garbage)
- [ ] Of all Form D rows: ≥85% have a populated officer.
- [ ] Of all rows: ≥40% have either a verified Email or a plausible Guessed Email.
- [ ] Daily cron runs at 03:00 local and produces an updated CSV within 30 minutes for a normal day's volume.
- [ ] Total cost per month: $0 if running SMTP-only; <$100 if using a paid verification API.

---

## 12. Handoff checklist for Claude Code

Before starting the build:

- [ ] Read this entire document.
- [ ] Read `msc-v7.html` lines 1117–1240 to understand the dashboard's CSV ingestion logic exactly. Don't break it.
- [ ] Inspect the attached `edgar_filings.csv` to see the current broken state — this is the baseline to improve on.
- [ ] Confirm Python 3.12+ available, network access to `*.sec.gov` and `*.efts.sec.gov`.
- [ ] Confirm whether we have an MSC office IP for SMTP probing, or if we need to budget for a paid verification API.

When building:

- [ ] Build phases in order. Don't start Phase N+1 until Phase N produces visible improvement in the dashboard.
- [ ] Commit per phase. Each phase should be reviewable on its own.
- [ ] Keep the test fixtures (`tests/fixtures/`) — they're how we'll catch the XPath-scoping bug from the previous build before it ships again.
- [ ] No dependencies on Hunter, Apollo, ZoomInfo, RocketReach, Clearbit, or any contact-data vendor. Free SEC data + open-source tooling only. Optional: one of the SMTP verification APIs in §4c-B.

When done:

- [ ] Hand back a folder with `start.command` (Mac launcher), `requirements.txt`, all source, and a one-page README pointing at this document.
- [ ] Run the full historical pull. Drop the resulting `edgar_filings.csv` in the project folder.
- [ ] Load it in the dashboard. Take a screenshot showing populated First Name / Role / Email columns.

---

## 13. Open questions for Rod / Feri before building

These would change the design materially — decide up front:

1. **Paid email verification: yes/no?** $40–$80/month gets us much better email accuracy especially on Reg A+ targets. If no, plan for higher manual-review burden.
2. **SMTP probe origin IP.** Cloud IPs get blocked. Where does the daily cron run — office, dev's Mac, dedicated VPS, residential IP?
3. **Storage of unsent emails.** Once we generate candidate addresses, do we want to keep them all in SQLite for audit, or only retain verified ones? (GDPR-adjacent question for any EU-resident officers picked up via Reg S.)
4. **2022 historical backfill.** Current CSV starts in 2023. Is reaching back to 2022 a must-have or nice-to-have? It's an extra ~5,000 Reg D filings to process.

---

*End of document. Source data: `msc-v7__2_.html` (2,119 lines), `edgar_filings.csv` (26,207 rows, columns analyzed §2.2). Generated for hand-off to Claude Code on the MSC SEC outreach project.*
