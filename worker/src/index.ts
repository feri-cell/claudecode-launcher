// MSC EDGAR enrichment Worker — entry point.
//   fetch():     serves the UI (static assets) and the /api/* endpoints
//   scheduled(): every minute, advances the resumable backfill by one tick
import { tick, startCrawl, getState, setState, migrate } from "./crawl";
import { REGULATION_FORMS } from "./discovery";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  USER_AGENT: string;
  MAX_REQUESTS_PER_TICK: string;
  REQUESTS_PER_SECOND: string;
  EMAIL_PER_TICK?: string;     // max companies to email-enrich per tick (default 40, budget-bound)
  EMAIL_REQUEST_RESERVE?: string; // per-tick requests reserved for email finding (default 16)
  EMAIL_SCRAPE_PAGES?: string; // site pages to scrape per company (default 3)
  VERIFY_TOKEN?: string;       // shared secret for the external SMTP verifier (wrangler secret)
  INCREMENTAL_HOURS?: string;        // cadence for new-filings re-discovery (default 12)
  INCREMENTAL_OVERLAP_DAYS?: string; // lookback window for the incremental pass (default 10)
  SEARCH_API_KEY?: string;           // optional: web-search key for domain discovery (inert if unset)
  SEARCH_PROVIDER?: string;          // 'brave' (default) | 'bing'
  SEARCH_MONTHLY_CAP?: string;       // hard monthly query cap to stay in free tier (default 1800)
  SEARCH_MAX_PER_TICK?: string;      // max search lookups per cron tick (default 1)
  VERIFY_API_KEY?: string;           // optional: HTTPS email-verification key (Verifalia "user:pass" etc.); inert if unset
  VERIFY_API_PROVIDER?: string;      // 'verifalia' | 'abstract' | 'mailboxlayer' | 'hunter'
  VERIFY_API_DAILY_CAP?: string;     // free-tier daily cap (default 24; 0 disables) — Verifalia is ~25/day
  VERIFY_API_MONTHLY_CAP?: string;   // free-tier monthly cap (default 740)
  VERIFY_API_PER_TICK?: string;      // emails verified per tick (default 1)
  VERIFY_API_REQUESTS_PER_TICK?: string; // request budget reserved for verify per tick (default 3)
}

// Allowed verdicts the external SMTP verifier may write back.
const VERIFY_STATUSES = new Set(["verified", "invalid", "probable", "guessed"]);

function authedVerifier(request: Request, env: Env): boolean {
  if (!env.VERIFY_TOKEN) return false; // endpoint disabled until the secret is set
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${env.VERIFY_TOKEN}`;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      const resp = await env.ASSETS.fetch(request);
      // The dashboard is a single HTML file that changes on every deploy. Serve it
      // with no-store so neither the browser nor Cloudflare's edge ever shows a
      // stale build after a deploy (this was causing "I don't see my changes").
      if ((resp.headers.get("content-type") || "").includes("text/html")) {
        const h = new Headers(resp.headers);
        h.set("cache-control", "no-store, no-cache, must-revalidate");
        h.set("cdn-cache-control", "no-store");
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      return resp;
    }

    try {
      await migrate(env); // ensure Layer 4 columns exist before any /api query reads them
      // POST /api/enrich {regs:["D","A+"]} — seed + start the crawl, run one tick now.
      if (path === "/api/enrich" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { regs?: string[] };
        let regs = body.regs ?? [];
        if (!regs.length || regs.includes("ALL")) regs = Object.keys(REGULATION_FORMS);
        const seeded = await startCrawl(env, regs);
        ctx.waitUntil(tick(env)); // immediate progress without waiting for cron
        return json({ ok: true, regs, windows_seeded: seeded });
      }

      // POST /api/tick — run one crawl tick now and wait for it (manual kick).
      if (path === "/api/tick" && request.method === "POST") {
        return json(await tick(env));
      }

      // POST /api/stop — pause the crawl (state is preserved; resume re-enables).
      if (path === "/api/stop" && request.method === "POST") {
        await setState(env, "paused", "1");
        return json({ ok: true, paused: true });
      }

      // GET /api/progress — counts for the live progress bar.
      if (path === "/api/progress") return json(await progress(env));

      // GET /api/contacts?limit=100 — enriched top-3 contacts for the results table.
      // The dashboard pulls the full set as JSON (no CSV), so allow a large cap.
      if (path === "/api/contacts") {
        const limit = Math.min(100000, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return json(await contacts(env, limit));
      }

      // GET /api/export.csv — v7 dashboard schema (brief §6).
      if (path === "/api/export.csv") return exportCsv(env);

      // --- external SMTP verifier API (Bearer VERIFY_TOKEN) ----------------- //
      // GET /api/verify/pending?limit=N — hand out un-probed pattern guesses.
      if (path === "/api/verify/pending") {
        if (!authedVerifier(request, env)) return json({ error: "unauthorized" }, 401);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return json(await verifyPending(env, limit));
      }
      // POST /api/verify/result {results:[{id,status,code}]} — write verdicts back.
      if (path === "/api/verify/result" && request.method === "POST") {
        if (!authedVerifier(request, env)) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { results?: any[] };
        return json(await verifyResult(env, body.results ?? []));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },
};

// --- progress snapshot ----------------------------------------------------- //
async function progress(env: Env) {
  const q = (sql: string) => env.DB.prepare(sql).first<any>();
  const [win, fil, comp, off, eml] = await Promise.all([
    q("SELECT COUNT(*) AS total, SUM(status='done') AS done FROM disco_windows"),
    q("SELECT COUNT(*) AS total, SUM(status='parsed') AS parsed, SUM(status='incomplete') AS incomplete FROM filings"),
    q("SELECT COUNT(*) AS total, SUM(status='enriched') AS enriched, SUM(website IS NOT NULL) AS with_website, SUM(is_operating=1) AS operating FROM companies"),
    q("SELECT COUNT(*) AS total, SUM(is_top_3=1) AS top3 FROM officers"),
    q(
      "SELECT (SELECT COUNT(*) FROM officers WHERE is_top_3=1 AND id IN (SELECT officer_id FROM emails WHERE verification_status='verified')) AS verified, " +
        "(SELECT COUNT(*) FROM emails WHERE verification_status='verified' AND (response_code LIKE 'smtp%' OR response_code LIKE 'verifalia%' OR response_code LIKE 'api%')) AS verified_mailbox, " +
        "(SELECT COUNT(*) FROM emails WHERE verification_status='verified' AND response_code='scraped_site') AS verified_scraped, " +
        "(SELECT COUNT(*) FROM officers WHERE is_top_3=1 AND id IN (SELECT officer_id FROM emails WHERE verification_status='probable') " +
        "  AND id NOT IN (SELECT officer_id FROM emails WHERE verification_status='verified')) AS probable, " +
        "(SELECT COUNT(*) FROM emails WHERE response_code IS NOT NULL AND response_code LIKE 'smtp%') AS smtp_checked, " +
        "(SELECT COUNT(*) FROM emails WHERE verification_status='invalid') AS invalid, " +
        "(SELECT COUNT(*) FROM officers WHERE is_top_3=1 AND id IN (SELECT officer_id FROM emails)) AS with_any, " +
        "(SELECT COUNT(*) FROM companies WHERE email_status='done') AS companies_done"
    ),
  ]);
  const [active, paused, started, lastTick, regs] = await Promise.all([
    getState(env, "active"),
    getState(env, "paused"),
    getState(env, "started_at"),
    getState(env, "last_tick_at"),
    getState(env, "regs"),
  ]);
  return {
    active: active === "1",
    paused: paused === "1",
    regs: regs ? regs.split(",") : [],
    started_at: started,
    last_tick_at: lastTick,
    discovery: { total: num(win?.total), done: num(win?.done) },
    filings: { total: num(fil?.total), parsed: num(fil?.parsed), incomplete: num(fil?.incomplete) },
    companies: { total: num(comp?.total), enriched: num(comp?.enriched), with_website: num(comp?.with_website), operating: num(comp?.operating) },
    officers: { total: num(off?.total), top3: num(off?.top3) },
    emails: { verified: num(eml?.verified), verified_mailbox: num(eml?.verified_mailbox), verified_scraped: num(eml?.verified_scraped), probable: num(eml?.probable), invalid: num(eml?.invalid), smtp_checked: num(eml?.smtp_checked), with_any: num(eml?.with_any), companies_done: num(eml?.companies_done) },
  };
}
const num = (v: any) => Number(v ?? 0);

// --- contacts (top-3 officers + company) ----------------------------------- //
// Email confidence tiers (free, Worker-graded): 'verified' (scraped off the
// company site), 'probable' (pattern on a confirmed domain with MX), 'guessed'
// (pattern, weaker). `email` = the verified address; `guessed_email` = best
// non-verified, preferring probable; `email_status` = the top tier present.
const CONTACTS_SQL =
  "SELECT c.cik, c.name AS company, c.website, c.domain, c.domain_verified, c.state, c.is_operating, " +
  "f1.regulation, f1.form_type, f1.filing_date, " +
  "o.first, o.last, o.role, o.role_priority, o.source_accession, o.source_type, " +
  "(SELECT e.address FROM emails e WHERE e.officer_id=o.id AND e.verification_status='verified' ORDER BY e.id LIMIT 1) AS email, " +
  "(SELECT e.response_code FROM emails e WHERE e.officer_id=o.id AND e.verification_status='verified' ORDER BY e.id LIMIT 1) AS email_code, " +
  "(SELECT e.address FROM emails e WHERE e.officer_id=o.id AND e.verification_status IN ('probable','guessed') " +
  "  ORDER BY (e.verification_status='probable') DESC, e.id LIMIT 1) AS guessed_email, " +
  "(SELECT e.verification_status FROM emails e WHERE e.officer_id=o.id AND e.verification_status!='invalid' " +
  "  ORDER BY CASE e.verification_status WHEN 'verified' THEN 0 WHEN 'probable' THEN 1 ELSE 2 END, e.id LIMIT 1) AS email_status " +
  "FROM officers o JOIN companies c ON c.cik=o.cik " +
  "LEFT JOIN filings f1 ON f1.accession=o.source_accession " +
  "WHERE o.is_top_3=1 ORDER BY o.cik, o.rank LIMIT ?";

async function contacts(env: Env, limit: number) {
  const rows = (await env.DB.prepare(CONTACTS_SQL).bind(limit).all<any>()).results;
  return { count: rows.length, contacts: rows };
}

// --- external SMTP verifier support ---------------------------------------- //
// Hand out pattern-guess addresses that haven't been SMTP-probed yet (no
// response_code). 'probable' (domain has MX) first — they're worth probing most.
async function verifyPending(env: Env, limit: number) {
  const rows = (
    await env.DB.prepare(
      "SELECT id, address FROM emails " +
        "WHERE verification_status IN ('probable','guessed') AND response_code IS NULL " +
        "ORDER BY (verification_status='probable') DESC, id LIMIT ?"
    )
      .bind(limit)
      .all<any>()
  ).results;
  return { count: rows.length, candidates: rows };
}

// Write back SMTP verdicts. 250 -> verified, 55x -> invalid, catch-all/timeout
// -> left as 'probable' but stamped with a response_code so it isn't re-probed.
async function verifyResult(env: Env, results: any[]) {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  for (const r of results) {
    const id = Number(r?.id);
    const status = String(r?.status || "");
    const code = String(r?.code || "").slice(0, 40);
    if (!id || !VERIFY_STATUSES.has(status)) continue;
    stmts.push(
      env.DB.prepare(
        "UPDATE emails SET verification_status=?, response_code=?, verified_at=? WHERE id=?"
      ).bind(status, code || "smtp", status === "verified" ? now : null, id)
    );
    updated++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, updated };
}

// --- CSV export (v7 dashboard columns) ------------------------------------- //
async function exportCsv(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(CONTACTS_SQL).bind(100000).all<any>()).results;
  const cols = [
    "Company Name", "CIK", "Regulation", "Form Type", "Filing Date",
    "First Name", "Last Name", "Role", "Email", "Guessed Email", "Email Status", "EDGAR URL", "Source",
  ];
  const lines = [cols.join(",")];
  for (const r of rows) {
    const edgarUrl = r.source_accession
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${r.cik}&type=&dateb=&owner=include&count=40`
      : "";
    // Human-readable tier; 'verified' is split by method so SMTP/mailbox-checked
    // emails are distinguishable from ones merely published on the company site.
    const statusLabel = r.email
      ? (/^(smtp|verifalia|api)/.test(String(r.email_code || "").toLowerCase())
          ? "Verified (SMTP)"
          : "Verified (site)")
      : r.email_status === "probable"
        ? "Probable"
        : r.guessed_email
          ? "Guessed"
          : "";
    lines.push(
      [
        r.company, r.cik, r.regulation, r.form_type, r.filing_date,
        r.first, r.last, r.role, r.email ?? "", r.guessed_email ?? "", statusLabel, edgarUrl, r.source_type,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="msc_edgar_contacts.csv"',
      "access-control-allow-origin": "*",
    },
  });
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
