// The crawl engine. One tick() advances the backfill by a bounded number of
// EDGAR requests (Budget) and is fully resumable from D1, so a 1-minute Cron
// Trigger pages through "everything EDGAR has" over hours/days without ever
// exceeding EDGAR's rate ceiling or the Worker's per-invocation limits.
//
// Work priority per tick: finish discovery → enrich companies → extract officers.

import type { Env } from "./index";
import { Budget, EdgarClient, EFTS_RESULT_CAP } from "./edgar";
import { REGULATION_FORMS, formStartYear, parseHit } from "./discovery";
import { submissionsUrl, parseSubmissions, classifyOperating } from "./company";
import { parseDocument } from "./officers";
import { TOP_N_OFFICERS } from "./roles";
import {
  domainFromWebsite,
  guessDomainCandidates,
  generatePatterns,
  generateForPattern,
  patternOf,
  extractEmailsAtDomain,
  matchOfficerEmail,
  pageMentionsCompany,
  extractWebsiteFromFiling,
  isNonIssuerHost,
  hostMatchesCompany,
  SCRAPE_PATHS,
} from "./email";

const nowIso = () => new Date().toISOString();

// --- crawl_state key/value ------------------------------------------------- //
export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM crawl_state WHERE key=?").bind(key).first<any>();
  return row ? (row.value as string) : null;
}
export async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO crawl_state (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  )
    .bind(key, value, nowIso())
    .run();
}

// --- lease lock so manual + cron ticks never overlap ----------------------- //
async function acquireLease(env: Env, ttlMs = 90_000): Promise<boolean> {
  await env.DB.prepare("INSERT OR IGNORE INTO crawl_state (key, value) VALUES ('lease_until','0')").run();
  const now = Date.now();
  const res = await env.DB.prepare(
    "UPDATE crawl_state SET value=?, updated_at=? WHERE key='lease_until' AND CAST(value AS INTEGER) < ?"
  )
    .bind(String(now + ttlMs), nowIso(), now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
async function releaseLease(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE crawl_state SET value='0', updated_at=? WHERE key='lease_until'")
    .bind(nowIso())
    .run();
}

// --- schema migration ------------------------------------------------------ //
// The first remote D1 was created before the Layer 4 columns existed. D1 has no
// "ADD COLUMN IF NOT EXISTS", so we run each ALTER once, guarded by a version
// flag, and swallow the "duplicate column" error on DBs that already have them.
const SCHEMA_VERSION = "4";
const MIGRATIONS = [
  // v2 — Layer 4 email columns.
  "ALTER TABLE companies ADD COLUMN domain TEXT",
  "ALTER TABLE companies ADD COLUMN domain_verified INTEGER DEFAULT 0",
  "ALTER TABLE companies ADD COLUMN email_status TEXT",
  // v3 — tag discovery windows so the incremental (new-filings-only) pass can be
  // distinguished from, and cleaned up independently of, the historical backfill.
  "ALTER TABLE disco_windows ADD COLUMN kind TEXT DEFAULT 'backfill'",
  // v4 — segmentation (operating company vs SPV/fund/shell) so outreach lists
  // aren't diluted, and the learned dominant email pattern per company.
  "ALTER TABLE companies ADD COLUMN is_operating INTEGER",
  "ALTER TABLE companies ADD COLUMN email_pattern TEXT",
];

export async function migrate(env: Env): Promise<void> {
  if ((await getState(env, "schema_version")) === SCHEMA_VERSION) return;
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) throw e; // already applied
    }
  }
  await setState(env, "schema_version", SCHEMA_VERSION);
}

// --- seeding: enqueue yearly discovery windows for the selected regs -------- //
export async function startCrawl(env: Env, regs: string[]): Promise<number> {
  const valid = regs.filter((r) => REGULATION_FORMS[r]);
  const year = new Date().getUTCFullYear();
  const stmts: D1PreparedStatement[] = [];
  for (const reg of valid) {
    for (const form of REGULATION_FORMS[reg]) {
      for (let y = formStartYear(form); y <= year; y++) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO disco_windows (regulation, form_type, start_date, end_date, status) " +
              "VALUES (?, ?, ?, ?, 'pending')"
          ).bind(reg, form, `${y}-01-01`, `${y}-12-31`)
        );
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setState(env, "regs", valid.join(","));
  await setState(env, "active", "1");
  await setState(env, "paused", "0");
  await setState(env, "started_at", nowIso());
  return stmts.length;
}

// --- persistence ----------------------------------------------------------- //
async function persistRecords(env: Env, reg: string, records: ReturnType<typeof parseHit>[]): Promise<void> {
  const recs = records.filter((r): r is NonNullable<typeof r> => r !== null);
  if (!recs.length) return;
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const r of recs) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO companies (cik, name, website_source, first_seen_at, last_updated_at) " +
          "VALUES (?, ?, 'unknown', ?, ?) " +
          "ON CONFLICT(cik) DO UPDATE SET name = COALESCE(companies.name, excluded.name)"
      ).bind(r.cik, r.companyName, now, now)
    );
  }
  for (const r of recs) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO filings (accession, cik, regulation, form_type, filing_date, primary_doc, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'filed') ON CONFLICT(accession) DO NOTHING"
      ).bind(r.accession, r.cik, reg, r.formType, r.filingDate, r.primaryDoc)
    );
  }
  await env.DB.batch(stmts);
}

// --- step 1: discovery ----------------------------------------------------- //
async function pendingWindowCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM disco_windows WHERE status='pending'").first<any>();
  return Number(row?.c ?? 0);
}

async function stepDiscovery(env: Env, client: EdgarClient, skip: Set<number>): Promise<"ok" | "none"> {
  const skipList = skip.size ? ` AND id NOT IN (${[...skip].join(",")})` : "";
  const w = await env.DB.prepare(
    `SELECT * FROM disco_windows WHERE status='pending'${skipList} ORDER BY id LIMIT 1`
  ).first<any>();
  if (!w) return "none";

  let total: number, relation: string, hits: any[];
  try {
    ({ total, relation, hits } = await client.eftsQuery(w.form_type, w.start_date, w.end_date, w.from_offset));
  } catch (e) {
    // One window's transient EFTS failure must not abort the tick. Skip it for
    // this tick; after 5 consecutive failures park it as 'error'.
    skip.add(w.id);
    const attempts = (w.attempts ?? 0) + 1;
    await env.DB.prepare("UPDATE disco_windows SET attempts=?, status=?, last_error=? WHERE id=?")
      .bind(attempts, attempts >= 5 ? "error" : "pending", String(e).slice(0, 300), w.id)
      .run();
    return "ok";
  }
  const overCap = relation !== "eq" || total >= EFTS_RESULT_CAP;

  // Busy window: bisect into two and re-queue (only on the first page).
  if (overCap && w.from_offset === 0 && w.start_date < w.end_date) {
    const mid = midDate(w.start_date, w.end_date);
    await env.DB.batch([
      env.DB.prepare("UPDATE disco_windows SET status='done', total=? WHERE id=?").bind(total, w.id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO disco_windows (regulation, form_type, start_date, end_date, status) VALUES (?,?,?,?, 'pending')"
      ).bind(w.regulation, w.form_type, w.start_date, mid),
      env.DB.prepare(
        "INSERT OR IGNORE INTO disco_windows (regulation, form_type, start_date, end_date, status) VALUES (?,?,?,?, 'pending')"
      ).bind(w.regulation, w.form_type, addDay(mid), w.end_date),
    ]);
    return "ok";
  }

  // Leaf (or resuming) window: persist this page, advance the cursor.
  await persistRecords(env, w.regulation, hits.map((h: any) => parseHit(h, w.form_type)));
  const next = w.from_offset + hits.length;
  const done = hits.length === 0 || next >= Math.min(total, EFTS_RESULT_CAP);
  await env.DB.prepare("UPDATE disco_windows SET from_offset=?, total=?, attempts=0, status=? WHERE id=?")
    .bind(next, total, done ? "done" : "pending", w.id)
    .run();
  return "ok";
}

// --- step 2: company enrichment -------------------------------------------- //
async function stepCompany(env: Env, client: EdgarClient, max: number): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT cik FROM companies WHERE status IS NULL ORDER BY cik LIMIT ?").bind(max).all<any>()
  ).results;
  let done = 0;
  for (const row of rows) {
    if (client.budget.exhausted) break;
    const cik = Number(row.cik);
    try {
      const j = await client.getJson(submissionsUrl(cik));
      const f = parseSubmissions(j);
      const isOperating = classifyOperating(f.name, f.sic);
      await env.DB.prepare(
        "UPDATE companies SET name=COALESCE(?, name), sic=?, sic_description=?, state=?, " +
          "website=COALESCE(?, website), website_source=CASE WHEN ? IS NOT NULL THEN 'verified' ELSE website_source END, " +
          "is_operating=?, status='enriched', last_updated_at=? WHERE cik=?"
      )
        .bind(f.name, f.sic, f.sicDescription, f.state, f.website, f.website, isOperating, nowIso(), cik)
        .run();
    } catch {
      await env.DB.prepare("UPDATE companies SET status='enriched', last_updated_at=? WHERE cik=?")
        .bind(nowIso(), cik)
        .run();
    }
    done++;
  }
  return done;
}

// --- step 3: officer extraction -------------------------------------------- //
async function stepOfficers(env: Env, client: EdgarClient, max: number): Promise<number> {
  const rows = (
    await env.DB.prepare(
      "SELECT f.accession, f.cik, f.form_type, f.primary_doc, c.name, c.website " +
        "FROM filings f JOIN companies c ON c.cik=f.cik " +
        "WHERE f.status='filed' ORDER BY f.filing_date DESC LIMIT ?"
    )
      .bind(max)
      .all<any>()
  ).results;
  let done = 0;
  for (const f of rows) {
    if (client.budget.exhausted) break;
    const nodash = String(f.accession).replace(/-/g, "");
    const doc = f.primary_doc || "primary_doc.xml";
    const url = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${nodash}/${doc}`;
    try {
      const content = await client.getText(url);
      // Free win: harvest the issuer's own website from the document we just
      // pulled (only if EDGAR didn't already disclose one). This feeds Layer 4's
      // trusted-domain path and is the biggest lever on email yield.
      if (!f.website) {
        const site = extractWebsiteFromFiling(content, f.name);
        if (site) {
          await env.DB.prepare(
            "UPDATE companies SET website=?, website_source='filing', last_updated_at=? WHERE cik=? AND website IS NULL"
          )
            .bind(site, nowIso(), Number(f.cik))
            .run();
        }
      }
      const officers = parseDocument(f.form_type, content);
      if (officers.length) {
        await storeOfficers(env, Number(f.cik), String(f.accession), officers);
        await recomputeTop3(env, Number(f.cik));
        await env.DB.prepare("UPDATE filings SET status='parsed' WHERE accession=?").bind(f.accession).run();
      } else {
        await env.DB.prepare("UPDATE filings SET status='incomplete', last_error='no officers found' WHERE accession=?")
          .bind(f.accession)
          .run();
      }
    } catch (e) {
      await env.DB.prepare("UPDATE filings SET status='incomplete', last_error=? WHERE accession=?")
        .bind(String(e).slice(0, 300), f.accession)
        .run();
    }
    done++;
  }
  return done;
}

async function storeOfficers(env: Env, cik: number, accession: string, officers: ReturnType<typeof parseDocument>) {
  const stmts = officers.map((o) =>
    env.DB.prepare(
      "INSERT INTO officers (cik, full_name, first, last, role, role_priority, source_accession, source_type) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cik, full_name, role) DO NOTHING"
    ).bind(cik, o.full_name, o.first, o.last, o.role, o.role_priority, accession, o.source_type)
  );
  if (stmts.length) await env.DB.batch(stmts);
}

async function recomputeTop3(env: Env, cik: number): Promise<void> {
  const rows = (
    await env.DB.prepare(
      "SELECT o.id FROM officers o LEFT JOIN filings f ON f.accession=o.source_accession " +
        "WHERE o.cik=? ORDER BY o.role_priority ASC, COALESCE(f.filing_date,'') DESC, o.id ASC"
    )
      .bind(cik)
      .all<any>()
  ).results;
  const stmts = rows.map((r, i) =>
    env.DB.prepare("UPDATE officers SET rank=?, is_top_3=? WHERE id=?").bind(i + 1, i + 1 <= TOP_N_OFFICERS ? 1 : 0, r.id)
  );
  if (stmts.length) await env.DB.batch(stmts);
}

// --- search-API domain discovery (optional, gated on SEARCH_API_KEY) ------- //
// When a web-search key is configured, resolve a company's official domain by
// searching "<name> official website" and taking the first organic result whose
// host is tied to the company name and isn't a filing-agent/CDN/social. Inert
// (returns null) when no key is set, so the build ships dormant until you supply
// one. Supports Brave (default) and Bing.
async function resolveDomainViaSearch(
  env: Env,
  client: EdgarClient,
  name: string | null | undefined
): Promise<string | null> {
  const key = env.SEARCH_API_KEY;
  if (!key || !name) return null;
  const provider = (env.SEARCH_PROVIDER || "brave").toLowerCase();
  const q = `${name} official website`;
  let url: string;
  let headers: Record<string, string>;
  let pick: (j: any) => string[];
  if (provider === "bing") {
    url = `https://api.bing.microsoft.com/v7.0/search?count=5&responseFilter=Webpages&q=${encodeURIComponent(q)}`;
    headers = { "Ocp-Apim-Subscription-Key": key };
    pick = (j) => (j?.webPages?.value ?? []).map((r: any) => r?.url).filter(Boolean);
  } else {
    url = `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(q)}`;
    headers = { "X-Subscription-Token": key };
    pick = (j) => (j?.web?.results ?? []).map((r: any) => r?.url).filter(Boolean);
  }
  const j = await client.getExternalJson(url, headers);
  if (!j) return null;
  for (const u of pick(j)) {
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
      if (host.length < 4 || isNonIssuerHost(host)) continue;
      if (hostMatchesCompany(host, name)) return host;
    } catch {
      /* skip malformed URL */
    }
  }
  return null;
}

// --- step 4: email finding ------------------------------------------------- //
// Resolve a mail domain for each enriched company with top-3 officers, then emit
// addresses graded by confidence:
//   • verified — scraped off the site and strictly matched to the officer
//   • probable — pattern on a domain whose ownership is CONFIRMED (a disclosed/
//                filing-harvested/searched website, or a homepage that mentions
//                the company) AND that has an MX record
//   • guessed  — pattern on a name/search domain that merely has an MX record;
//                the off-Worker SMTP verifier later promotes or kills these
// Operating companies are processed before SPVs/funds (which rarely have any web
// footprint). Once an officer's address is scraped+matched we learn the domain's
// dominant local-part pattern and emit a single high-confidence guess for the
// rest, instead of all eight templates (Hunter.io-style per-domain pattern).
async function stepEmail(env: Env, client: EdgarClient, max: number): Promise<number> {
  // A company is email-able as soon as it has top-3 officers + a name — it does
  // NOT need the separate company-enrichment step first. (Enrichment fills SIC /
  // state and a website that EDGAR submissions almost never provides anyway; we
  // harvest/guess the domain here regardless.) Gating on status='enriched' made
  // the queue nearly empty, because officer extraction (newest filings first) and
  // enrichment (lowest CIK first) advance over different companies.
  const companies = (
    await env.DB.prepare(
      "SELECT cik, name, website, email_pattern FROM companies " +
        "WHERE email_status IS NULL AND name IS NOT NULL " +
        "AND EXISTS (SELECT 1 FROM officers o WHERE o.cik=companies.cik AND o.is_top_3=1) " +
        "ORDER BY is_operating DESC, cik LIMIT ?"
    )
      .bind(max)
      .all<any>()
  ).results;

  const scrapePages = Math.max(1, Number(env.EMAIL_SCRAPE_PAGES) || 3);
  let done = 0;
  for (const c of companies) {
    if (client.budget.exhausted) break;
    const cik = Number(c.cik);
    try {
      const officers = (
        await env.DB.prepare(
          "SELECT id, first, last FROM officers WHERE cik=? AND is_top_3=1 ORDER BY rank"
        )
          .bind(cik)
          .all<any>()
      ).results;

      let domain: string | null = null;
      let trusted = false; // ownership established → safe to scrape + grade 'probable'
      let domainVerified = false; // domain has an MX record
      const scraped: string[] = [];

      const scrapeExtraPages = async (d: string) => {
        for (const path of SCRAPE_PATHS.slice(1, scrapePages)) {
          if (client.budget.exhausted) break;
          const html = await client.getExternalText(`https://${d}${path}`);
          if (html) scraped.push(...extractEmailsAtDomain(html, d));
        }
      };

      // Backfill the website for companies enriched before filing-harvest existed
      // (or whose docs we'd already parsed): pull their latest filing doc once and
      // harvest the issuer URL. New filings are harvested for free during officer
      // parsing, so this only fires for companies that still have no website.
      // Name-obvious SPVs/funds have no web/email footprint; don't spend the
      // budget chasing one (no harvest fetch, no MX probes) — mark them done with
      // no addresses so the budget goes to real operating companies.
      const isSpvByName = classifyOperating(c.name, null) === 0;

      let website: string | null = c.website;
      if (!website && !isSpvByName && !client.budget.exhausted) {
        // Only HTML offering docs carry a website; Form D is XML and never does,
        // so skip it to avoid wasting a fetch.
        const f = await env.DB.prepare(
          "SELECT cik, accession, primary_doc FROM filings WHERE cik=? AND status='parsed' " +
            "AND form_type NOT IN ('D','D/A') ORDER BY filing_date DESC LIMIT 1"
        )
          .bind(cik)
          .first<any>();
        if (f) {
          const nodash = String(f.accession).replace(/-/g, "");
          const doc = f.primary_doc || "primary_doc.xml";
          const content = await client.getText(
            `https://www.sec.gov/Archives/edgar/data/${f.cik}/${nodash}/${doc}`
          ).catch(() => null);
          if (content) {
            const site = extractWebsiteFromFiling(content, c.name);
            if (site) {
              website = site;
              await env.DB.prepare(
                "UPDATE companies SET website=?, website_source='filing', last_updated_at=? WHERE cik=? AND website IS NULL"
              )
                .bind(site, nowIso(), cik)
                .run();
            }
          }
        }
      }

      const websiteDomain = domainFromWebsite(website);
      if (websiteDomain) {
        // Disclosed / filing-harvested website → trusted outright.
        domain = websiteDomain;
        trusted = true;
        domainVerified = await client.hasMxRecord(domain);
        if (!client.budget.exhausted) {
          const home = await client.getExternalText(`https://${domain}/`);
          if (home) scraped.push(...extractEmailsAtDomain(home, domain));
          await scrapeExtraPages(domain);
        }
      } else if (!isSpvByName) {
        // Best candidate first: a web-search hit (if a key is configured), then
        // name-guessed slugs across a few TLDs. Take the first with an MX record.
        const searched = await resolveDomainViaSearch(env, client, c.name);
        const cands: string[] = [];
        if (searched) cands.push(searched);
        for (const g of guessDomainCandidates(c.name)) if (!cands.includes(g)) cands.push(g);
        for (const d of cands) {
          if (client.budget.exhausted) break;
          if (await client.hasMxRecord(d)) {
            domain = d;
            domainVerified = true;
            break;
          }
        }
        // Confirm ownership via the homepage to upgrade guessed → probable and
        // trust scraped addresses.
        if (domain && !client.budget.exhausted) {
          const home = await client.getExternalText(`https://${domain}/`);
          if (home && pageMentionsCompany(home, c.name)) {
            trusted = true;
            scraped.push(...extractEmailsAtDomain(home, domain));
            await scrapeExtraPages(domain);
          }
        }
      }

      const scrapedUniq = [...new Set(scraped)];

      // Phase 1 — collect verified hits and learn the dominant pattern.
      let learnedPattern: string | null = c.email_pattern || null;
      const verifiedFor = new Map<number, string>();
      if (trusted) {
        for (const o of officers) {
          const first = String(o.first || "");
          const last = String(o.last || "");
          const hit = matchOfficerEmail(scrapedUniq, first, last);
          if (hit) {
            verifiedFor.set(Number(o.id), hit);
            if (!learnedPattern) {
              const p = patternOf(hit, first, last);
              if (p) learnedPattern = p;
            }
          }
        }
      }

      // Phase 2 — emit rows.
      if (domain && officers.length) {
        const guessStatus = trusted && domainVerified ? "probable" : "guessed";
        const stmts: D1PreparedStatement[] = [];
        const now = nowIso();
        for (const o of officers) {
          const first = String(o.first || "");
          const last = String(o.last || "");
          const v = verifiedFor.get(Number(o.id));
          if (v) {
            stmts.push(
              env.DB.prepare(
                "INSERT INTO emails (cik, officer_id, address, pattern, verification_status, response_code, verified_at) " +
                  "VALUES (?, ?, ?, 'scraped', 'verified', 'scraped_site', ?) " +
                  "ON CONFLICT(officer_id, address) DO UPDATE SET verification_status='verified', response_code='scraped_site', verified_at=excluded.verified_at"
              ).bind(cik, o.id, v, now)
            );
          }
          // If the dominant pattern is known, emit just that one (high-confidence);
          // otherwise emit the standard ranked set for the verifier to probe.
          const cands = learnedPattern
            ? ([generateForPattern(first, last, domain, learnedPattern)].filter(Boolean) as { address: string; pattern: string }[])
            : generatePatterns(first, last, domain);
          for (const cand of cands) {
            stmts.push(
              env.DB.prepare(
                "INSERT INTO emails (cik, officer_id, address, pattern, verification_status) VALUES (?, ?, ?, ?, ?) " +
                  "ON CONFLICT(officer_id, address) DO NOTHING"
              ).bind(cik, o.id, cand.address, cand.pattern, guessStatus)
            );
          }
        }
        if (stmts.length) await env.DB.batch(stmts);
      }

      // Name-only operating fallback for rows stepCompany left unclassified.
      const opFallback = classifyOperating(c.name, null);
      await env.DB.prepare(
        "UPDATE companies SET domain=?, domain_verified=?, email_pattern=COALESCE(?, email_pattern), " +
          "is_operating=COALESCE(is_operating, ?), email_status='done', last_updated_at=? WHERE cik=?"
      )
        .bind(domain, domainVerified ? 1 : 0, learnedPattern, opFallback, nowIso(), cik)
        .run();
    } catch (e) {
      // Don't let one company wedge the queue; mark done with no addresses.
      await env.DB.prepare("UPDATE companies SET email_status='done', last_updated_at=? WHERE cik=?")
        .bind(nowIso(), cik)
        .run();
      void e;
    }
    done++;
  }
  return done;
}



// --- incremental re-discovery (new filings only) --------------------------- //
// The historical backfill seeds yearly windows up to the current year; once they
// are all 'done' the crawl would sit idle forever and never see filings that
// arrive afterwards. This re-opens a short, recent window per active reg/form on
// a fixed cadence so ONLY new filings get pulled in — deduped by accession in
// persistRecords and flowed through the same officer/company/email pipeline.
//
// It runs only after the initial backfill has caught up (no pending 'backfill'
// windows), so the first run stays the "one long huge fill" the user expects and
// everything after it is a cheap delta.
async function maybeSeedIncremental(env: Env): Promise<void> {
  const regsCsv = await getState(env, "regs");
  if (!regsCsv) return; // a crawl was never started
  const regs = regsCsv.split(",").filter((r) => REGULATION_FORMS[r]);
  if (!regs.length) return;

  // Hold off while the historical backfill still has work queued.
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM disco_windows WHERE status='pending' AND COALESCE(kind,'backfill')='backfill'"
  ).first<any>();
  if (Number(pending?.c ?? 0) > 0) return;

  // Cadence gate.
  const intervalH = Math.max(1, Number(env.INCREMENTAL_HOURS) || 12);
  const last = await getState(env, "last_incremental_at");
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && Date.now() - lastMs < intervalH * 3_600_000) return; // not due yet
  }

  const overlapDays = Math.max(1, Number(env.INCREMENTAL_OVERLAP_DAYS) || 10);
  const today = nowIso().slice(0, 10);
  const start = subDays(today, overlapDays);

  // Replace the previous incremental windows so they never accumulate, then
  // queue one fresh recent window per active reg/form. These spans are short, so
  // they stay well under the EFTS cap and won't bisect into child rows.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM disco_windows WHERE COALESCE(kind,'backfill')='incremental'"),
  ];
  for (const reg of regs) {
    for (const form of REGULATION_FORMS[reg]) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO disco_windows (regulation, form_type, start_date, end_date, status, from_offset, kind) " +
            "VALUES (?, ?, ?, ?, 'pending', 0, 'incremental') " +
            "ON CONFLICT(regulation, form_type, start_date, end_date) " +
            "DO UPDATE SET status='pending', from_offset=0, attempts=0, kind='incremental'"
        ).bind(reg, form, start, today)
      );
    }
  }
  await env.DB.batch(stmts);
  await setState(env, "last_incremental_at", nowIso());
  await setState(env, "active", "1"); // wake the pipeline to process the new windows
}

// --- the tick -------------------------------------------------------------- //
export async function tick(env: Env): Promise<{ ran: boolean; fetched: number }> {
  if ((await getState(env, "paused")) === "1") return { ran: false, fetched: 0 };
  if (!(await acquireLease(env))) return { ran: false, fetched: 0 };
  await migrate(env);
  await maybeSeedIncremental(env).catch(() => {}); // never let this abort a tick
  const maxReq = Math.max(1, Number(env.MAX_REQUESTS_PER_TICK) || 40);
  // Give email finding its OWN budget so it can never be starved by
  // discovery/officers/company. A soft reserve didn't hold: EDGAR 429/5xx retries
  // spend extra budget per row, so phase 1 overshot and drained everything before
  // email ran. Two separate budgets make the split hard — total stays ≤ maxReq.
  const reserve = Math.min(maxReq - 1, Math.max(0, Number(env.EMAIL_REQUEST_RESERVE) || 16));
  const mainBudget = Math.max(1, maxReq - reserve);
  const mainClient = new EdgarClient(env, new Budget(mainBudget));
  let emailFetched = 0;
  try {
    // Phase 1 — round-robin discovery → officers → company on the main budget.
    // A failure in any one stage must not abort the tick.
    const skip = new Set<number>(); // windows that failed this tick
    let didAny = 0;
    while (!mainClient.budget.exhausted) {
      let did = 0;
      for (let i = 0; i < 5 && !mainClient.budget.exhausted; i++) {
        const r = await stepDiscovery(env, mainClient, skip).catch(() => "ok" as const);
        if (r === "none") break;
        did++;
      }
      if (!mainClient.budget.exhausted) did += await stepOfficers(env, mainClient, 8).catch(() => 0);
      if (!mainClient.budget.exhausted) did += await stepCompany(env, mainClient, 12).catch(() => 0);
      didAny += did;
      if (did === 0) break;
    }
    // Phase 2 — email finding on its own budget: the reserve PLUS whatever phase 1
    // left unspent (so a caught-up backfill pours its whole budget into email).
    const emailBudget = reserve + mainClient.budget.remaining;
    const emailMax = Math.max(1, Number(env.EMAIL_PER_TICK) || 40);
    if (emailBudget > 0) {
      const emailClient = new EdgarClient(env, new Budget(emailBudget));
      didAny += await stepEmail(env, emailClient, emailMax).catch(() => 0);
      emailFetched = emailClient.fetched;
    }
    if (didAny === 0) await setState(env, "active", "0"); // nothing left — caught up
  } finally {
    await setState(env, "last_tick_at", nowIso());
    await releaseLease(env);
  }
  return { ran: true, fetched: mainClient.fetched + emailFetched };
}

// --- date helpers (YYYY-MM-DD, UTC) ---------------------------------------- //
function addDay(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
function subDays(d: string, n: number): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}
function midDate(start: string, end: string): string {
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end + "T00:00:00Z").getTime();
  return new Date(a + Math.floor((b - a) / 2)).toISOString().slice(0, 10);
}
