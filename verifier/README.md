# MSC EDGAR — SMTP email verifier

Cloudflare Workers can't open outbound port 25, so true mailbox verification
(the `RCPT TO` → 250/550 probe) runs **here**, outside the Worker. This script
pulls un-probed pattern guesses from the Worker, probes them over SMTP, and
writes the verdicts back. **Node 18+ only — no `npm install` needed.**

## What it does

1. `GET /api/verify/pending` — fetch a batch of un-probed `probable`/`guessed` addresses
2. group by domain → resolve MX → detect catch-all servers (probe a junk address first)
3. `RCPT TO` each address and classify the reply
4. `POST /api/verify/result` — write verdicts back

Verdicts:

| Verdict | When | Shows in dashboard as |
|---|---|---|
| `verified` | 250 on a **non-catch-all** domain | ✓ VERIFIED |
| `invalid`  | 550/551/552/553, or domain has no MX | hidden (we know it's bad) |
| `probable` | catch-all domain, greylisted, or inconclusive | ~ probable |

Catch-all domains (Gmail/O365 tenants that accept everything) can't be trusted,
so they stay `probable` rather than being falsely marked verified.

## Where to run it

Anywhere outbound **TCP port 25 is allowed** — an office machine, a residential
VPS, etc. Most cloud providers (and Cloudflare) block port 25, so it will *not*
work from a typical datacenter IP. Check with:

```sh
nc -vz gmail-smtp-in.l.google.com 25   # "succeeded" = port 25 is open here
```

For best deliverability of the probes, run from an IP whose reverse DNS / SPF
lines up with `MAIL_FROM` (`manhattanstreetcapital.com`).

## Run

```sh
API_BASE=https://msc-edgar.feri-0df.workers.dev \
VERIFY_TOKEN=<the secret you set on the Worker> \
MAIL_FROM=outreach@manhattanstreetcapital.com \
node verify.mjs            # one pass then exit

node verify.mjs --watch    # keep polling for new candidates
```

### Setting the Worker secret (one time)

The endpoints are disabled until you set the shared secret on the Worker:

```sh
cd ../worker
echo "<pick-a-long-random-string>" | npx wrangler secret put VERIFY_TOKEN
```

Use that same string as `VERIFY_TOKEN` when running this script.

## Tunables (env vars)

| Var | Default | Meaning |
|---|---|---|
| `BATCH` | 100 | candidates fetched per pass |
| `MAX_PER_DOMAIN` | 25 | max probes per domain per pass (politeness cap) |
| `SLEEP_MS` | 1500 | pause between domains |
| `HELO_HOST` | manhattanstreetcapital.com | EHLO/HELO hostname |
| `PORT` | 25 | SMTP port |
| `CONNECT_TIMEOUT_MS` | 10000 | per-connection timeout |

## Run it as a service (systemd, on a port-25 host)

```ini
# /etc/systemd/system/msc-verifier.service
[Unit]
Description=MSC EDGAR SMTP verifier
After=network-online.target

[Service]
Environment=API_BASE=https://msc-edgar.feri-0df.workers.dev
Environment=VERIFY_TOKEN=REPLACE_ME
Environment=MAIL_FROM=outreach@manhattanstreetcapital.com
ExecStart=/usr/bin/node /opt/msc/verifier/verify.mjs --watch
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now msc-verifier
journalctl -u msc-verifier -f
```

Providers that will open outbound 25 on request: Hetzner (dedicated), OVH,
Scaleway, Contabo (ticket). Verify with `node verify.mjs --probe someone@gmail.com`
before wiring the service — if it hangs, port 25 is blocked there.

## Notes / etiquette

- One TCP connection per domain, reused across that domain's addresses (`RSET`
  between probes) — gentle on the mail server.
- Aggressive probing can get an IP greylisted or blocklisted. Keep `MAX_PER_DOMAIN`
  modest and don't hammer the same domain repeatedly.
- The Worker only hands out each address once per probe (it tracks `response_code`),
  so re-running won't re-probe already-decided addresses.
