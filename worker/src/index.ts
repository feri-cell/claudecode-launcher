// MSC EDGAR enrichment Worker — entry point.
//   fetch():     serves the UI (static assets) and the /api/* endpoints
//   scheduled(): every minute, advances the resumable backfill by one tick
import { tick, startCrawl, getState, setState } from "./crawl";
import { REGULATION_FORMS } from "./discovery";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  USER_AGENT: string;
  MAX_REQUESTS_PER_TICK: string;
  REQUESTS_PER_SECOND: string;
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

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
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
      if (path === "/api/contacts") {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return json(await contacts(env, limit));
      }

      // GET /api/export.csv — v7 dashboard schema (brief §6).
      if (path === "/api/export.csv") return exportCsv(env);

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
  const [win, fil, comp, off] = await Promise.all([
    q("SELECT COUNT(*) AS total, SUM(status='done') AS done FROM disco_windows"),
    q("SELECT COUNT(*) AS total, SUM(status='parsed') AS parsed, SUM(status='incomplete') AS incomplete FROM filings"),
    q("SELECT COUNT(*) AS total, SUM(status='enriched') AS enriched, SUM(website IS NOT NULL) AS with_website FROM companies"),
    q("SELECT COUNT(*) AS total, SUM(is_top_3=1) AS top3 FROM officers"),
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
    companies: { total: num(comp?.total), enriched: num(comp?.enriched), with_website: num(comp?.with_website) },
    officers: { total: num(off?.total), top3: num(off?.top3) },
  };
}
const num = (v: any) => Number(v ?? 0);

// --- contacts (top-3 officers + company) ----------------------------------- //
const CONTACTS_SQL =
  "SELECT c.cik, c.name AS company, c.website, c.state, f1.regulation, f1.form_type, f1.filing_date, " +
  "o.first, o.last, o.role, o.role_priority, o.source_accession, o.source_type " +
  "FROM officers o JOIN companies c ON c.cik=o.cik " +
  "LEFT JOIN filings f1 ON f1.accession=o.source_accession " +
  "WHERE o.is_top_3=1 ORDER BY o.cik, o.rank LIMIT ?";

async function contacts(env: Env, limit: number) {
  const rows = (await env.DB.prepare(CONTACTS_SQL).bind(limit).all<any>()).results;
  return { count: rows.length, contacts: rows };
}

// --- CSV export (v7 dashboard columns) ------------------------------------- //
async function exportCsv(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(CONTACTS_SQL).bind(100000).all<any>()).results;
  const cols = [
    "Company Name", "CIK", "Regulation", "Form Type", "Filing Date",
    "First Name", "Last Name", "Role", "Email", "Guessed Email", "EDGAR URL", "Source",
  ];
  const lines = [cols.join(",")];
  for (const r of rows) {
    const nodash = String(r.source_accession ?? "").replace(/-/g, "");
    const edgarUrl = r.source_accession
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${r.cik}&type=&dateb=&owner=include&count=40`
      : "";
    void nodash;
    lines.push(
      [
        r.company, r.cik, r.regulation, r.form_type, r.filing_date,
        r.first, r.last, r.role, "", "", edgarUrl, r.source_type,
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
