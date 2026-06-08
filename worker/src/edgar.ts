// Rate-limited EDGAR HTTP layer. SEC requires a real contact in the User-Agent
// and asks for <=10 req/s; we pace at REQUESTS_PER_SECOND (default 5).
//
// A tick runs in a single Worker isolate and issues requests sequentially, so a
// simple "minimum gap since last request start" limiter is sufficient and keeps
// us safely under EDGAR's ceiling. Each tick is also bounded by a request budget
// (see crawl.ts) to stay under the Worker subrequest/CPU limits.

import type { Env } from "./index";

export const EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
export const EFTS_PAGE_SIZE = 100;
export const EFTS_RESULT_CAP = 10_000;

export class Budget {
  remaining: number;
  constructor(max: number) {
    this.remaining = max;
  }
  get exhausted(): boolean {
    return this.remaining <= 0;
  }
  spend(): void {
    this.remaining -= 1;
  }
}

export class EdgarClient {
  private ua: string;
  private minGapMs: number;
  private lastStart = 0;
  readonly budget: Budget;
  fetched = 0;

  constructor(env: Env, budget: Budget) {
    this.ua = env.USER_AGENT;
    const rps = Math.max(0.5, Number(env.REQUESTS_PER_SECOND) || 5);
    this.minGapMs = Math.ceil(1000 / rps);
    this.budget = budget;
  }

  private async gate(): Promise<void> {
    const now = Date.now();
    const wait = this.lastStart + this.minGapMs - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart = Date.now();
  }

  // Low-level fetch with UA, rate gate, and a couple of retries on 429/5xx.
  private async raw(url: string, accept: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.gate();
      this.budget.spend();
      this.fetched += 1;
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": this.ua, Accept: accept },
          cf: { cacheTtl: 0 },
        });
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`HTTP ${resp.status}`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return resp;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getJson(url: string): Promise<any> {
    const r = await this.raw(url, "application/json");
    return r.json();
  }

  async getText(url: string): Promise<string> {
    const r = await this.raw(url, "*/*");
    return r.text();
  }

  // One EFTS page. Returns { total, relation, hits }.
  async eftsQuery(form: string, start: string, end: string, from: number) {
    const u = new URL(EFTS_SEARCH_URL);
    u.searchParams.set("forms", form);
    u.searchParams.set("startdt", start);
    u.searchParams.set("enddt", end);
    u.searchParams.set("from", String(from));
    u.searchParams.set("size", String(EFTS_PAGE_SIZE));
    const j = await this.getJson(u.toString());
    const hits = j?.hits ?? {};
    const total = hits.total ?? {};
    return {
      total: Number(total.value ?? 0),
      relation: String(total.relation ?? "eq"),
      hits: (hits.hits ?? []) as any[],
    };
  }
}
