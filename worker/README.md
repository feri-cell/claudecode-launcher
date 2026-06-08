# MSC EDGAR — all-Cloudflare Worker

The enrichment pipeline (discovery → company → officers) reimplemented in
TypeScript on a single Cloudflare Worker: it serves the UI, exposes the API, and
runs a resumable backfill on a 1-minute Cron Trigger. Emails (Layer 4) are next.

```
worker/
  public/index.html   # UI: regulation picker, Enrich button, live progress bar, contacts table
  schema.sql          # D1 (SQLite) schema + cron-engine tables
  src/
    index.ts          # fetch() router (/api/*) + scheduled() cron handler
    crawl.ts          # the tick engine: discovery↔company↔officers, rate-limited & resumable
    edgar.ts          # rate-limited EDGAR HTTP client + EFTS query
    discovery.ts      # EFTS hit parsing (issuer CIK = _source.ciks[0]); reg→forms map
    company.ts        # submissions JSON parsing
    officers.ts       # Form D XML + 1-A/S-F HTML parsers, name heuristics, ranking
    roles.ts          # role normalization + seniority priority
```

## Run locally

```bash
cd worker
npm install
npm run db:local                       # create local D1 + apply schema
npx wrangler dev                       # http://localhost:8787
# In another shell, kick the crawl (the UI's "Enrich" button does the same):
curl -XPOST localhost:8787/api/enrich -H 'content-type:application/json' -d '{"regs":["D"]}'
curl -XPOST localhost:8787/api/tick    # advance one tick (cron does this every minute in prod)
```

Open http://localhost:8787, pick a regulation, click **Enrich from EDGAR**, watch
the three-stage progress bar and the contacts table fill in. `regs` accepts any of
`A+`, `D`, `S`, `144A`, or `["ALL"]`.

> Note: `wrangler dev` does not auto-fire the cron locally. Use `POST /api/tick`
> (or the Enrich button, which runs one tick) to advance during local testing.

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create msc-edgar       # paste the printed database_id into wrangler.jsonc
npm run db:remote                      # apply schema to the remote D1
npm run deploy
```

The Cron Trigger (`* * * * *`) then advances the backfill automatically — close the
tab and it keeps going. For a full historical pull (`["ALL"]` back to each form's
earliest year) use the **Workers Paid** plan and raise `MAX_REQUESTS_PER_TICK`
(free plan caps subrequests at 50/invocation; keep it ≤45 there).

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/enrich` `{regs:[...]}` | Seed + start the crawl; runs one tick now |
| POST | `/api/tick` | Run one crawl tick and wait (manual kick) |
| POST | `/api/stop` | Pause (state preserved; Enrich resumes) |
| GET  | `/api/progress` | Counts for the progress bar |
| GET  | `/api/contacts?limit=` | Top-3 contacts per company |
| GET  | `/api/export.csv` | CSV in the v7 dashboard schema |

## Rate limits

Paced at `REQUESTS_PER_SECOND` (default 5; EDGAR's ceiling is 10/s per UA). Each
tick is bounded by `MAX_REQUESTS_PER_TICK` and fully checkpointed in D1, so the
1-minute cron paces a multi-day backfill without tripping EDGAR limits, and a
crash/redeploy resumes exactly where it left off. A window that repeatedly fails
an EFTS query is retried up to 5 times, then parked as `error` so it never blocks
the queue.
