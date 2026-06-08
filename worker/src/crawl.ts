// The crawl engine. One tick() advances the backfill by a bounded number of
// EDGAR requests (Budget) and is fully resumable from D1, so a 1-minute Cron
// Trigger pages through "everything EDGAR has" over hours/days without ever
// exceeding EDGAR's rate ceiling or the Worker's per-invocation limits.
//
// Work priority per tick: finish discovery → enrich companies → extract officers.

import type { Env } from "./index";
import { Budget, EdgarClient, EFTS_RESULT_CAP } from "./edgar";
import { REGULATION_FORMS, formStartYear, parseHit } from "./discovery";
import { submissionsUrl, parseSubmissions } from "./company";
import { parseDocument } from "./officers";
import { TOP_N_OFFICERS } from "./roles";

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
      await env.DB.prepare(
        "UPDATE companies SET name=COALESCE(?, name), sic=?, sic_description=?, state=?, " +
          "website=COALESCE(?, website), website_source=CASE WHEN ? IS NOT NULL THEN 'verified' ELSE website_source END, " +
          "status='enriched', last_updated_at=? WHERE cik=?"
      )
        .bind(f.name, f.sic, f.sicDescription, f.state, f.website, f.website, nowIso(), cik)
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
      "SELECT accession, cik, form_type, primary_doc FROM filings WHERE status='filed' ORDER BY filing_date DESC LIMIT ?"
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

// --- the tick -------------------------------------------------------------- //
export async function tick(env: Env): Promise<{ ran: boolean; fetched: number }> {
  if ((await getState(env, "paused")) === "1") return { ran: false, fetched: 0 };
  if (!(await acquireLease(env))) return { ran: false, fetched: 0 };
  const maxReq = Math.max(1, Number(env.MAX_REQUESTS_PER_TICK) || 40);
  const client = new EdgarClient(env, new Budget(maxReq));
  try {
    // Round-robin the three stages so officers/contacts surface in the first
    // tick instead of waiting for the entire backfill's discovery to finish.
    // A failure in any one stage must not abort the tick.
    const skip = new Set<number>(); // windows that failed this tick
    while (!client.budget.exhausted) {
      let did = 0;
      for (let i = 0; i < 5 && !client.budget.exhausted; i++) {
        const r = await stepDiscovery(env, client, skip).catch(() => "ok" as const);
        if (r === "none") break;
        did++;
      }
      if (!client.budget.exhausted) did += await stepOfficers(env, client, 8).catch(() => 0);
      if (!client.budget.exhausted) did += await stepCompany(env, client, 12).catch(() => 0);
      if (did === 0) {
        await setState(env, "active", "0"); // nothing left — backfill caught up
        break;
      }
    }
  } finally {
    await setState(env, "last_tick_at", nowIso());
    await releaseLease(env);
  }
  return { ran: true, fetched: client.fetched };
}

// --- date helpers (YYYY-MM-DD, UTC) ---------------------------------------- //
function addDay(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
function midDate(start: string, end: string): string {
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end + "T00:00:00Z").getTime();
  return new Date(a + Math.floor((b - a) / 2)).toISOString().slice(0, 10);
}
