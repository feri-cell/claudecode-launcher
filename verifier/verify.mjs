#!/usr/bin/env node
// MSC EDGAR — standalone SMTP email verifier.
//
// Cloudflare Workers cannot open outbound port 25, so true mailbox verification
// (the 250/550 RCPT-TO probe) has to run OUTSIDE the Worker. This script does
// exactly that, using only Node built-ins (no npm install):
//   1. pulls un-probed pattern guesses from the Worker  (GET  /api/verify/pending)
//   2. groups them by domain, resolves MX, detects catch-all servers
//   3. probes each address with RCPT TO and classifies the response
//   4. writes verdicts back to the Worker                (POST /api/verify/result)
//
// Verdicts written back:
//   verified  — server accepted the address (250) on a NON-catch-all domain
//   invalid   — server rejected the address (550/551/553)
//   probable  — left as-is (catch-all domain, or inconclusive/greylisted),
//               stamped with a response_code so it isn't re-probed forever
//
// Run it where outbound TCP/25 is allowed (office IP / residential VPS — most
// cloud providers block 25). Usage:
//   API_BASE=https://msc-edgar.feri-0df.workers.dev \
//   VERIFY_TOKEN=xxxxx \
//   MAIL_FROM=outreach@manhattanstreetcapital.com \
//   node verify.mjs            # one pass, then exit
//   node verify.mjs --watch    # keep polling for new candidates
//
// Optional env: HELO_HOST (default manhattanstreetcapital.com), BATCH (100),
// MAX_PER_DOMAIN (25), PORT (25), CONNECT_TIMEOUT_MS (10000), SLEEP_MS (1500).

import { Resolver } from "node:dns/promises";
import net from "node:net";

const API_BASE = (process.env.API_BASE || "").replace(/\/$/, "");
const TOKEN = process.env.VERIFY_TOKEN || "";
const MAIL_FROM = process.env.MAIL_FROM || "outreach@manhattanstreetcapital.com";
const HELO_HOST = process.env.HELO_HOST || "manhattanstreetcapital.com";
const BATCH = int(process.env.BATCH, 100);
const MAX_PER_DOMAIN = int(process.env.MAX_PER_DOMAIN, 25);
const PORT = int(process.env.PORT, 25);
const CONNECT_TIMEOUT_MS = int(process.env.CONNECT_TIMEOUT_MS, 10000);
const SLEEP_MS = int(process.env.SLEEP_MS, 1500);
const WATCH = process.argv.includes("--watch");

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function domainOf(addr) { return addr.slice(addr.lastIndexOf("@") + 1).toLowerCase(); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function requireConfig() {
  const missing = [];
  if (!API_BASE) missing.push("API_BASE");
  if (!TOKEN) missing.push("VERIFY_TOKEN");
  if (missing.length) { console.error("Missing env:", missing.join(", ")); process.exit(2); }
}

// --- Worker API ------------------------------------------------------------ //
async function fetchPending() {
  const r = await fetch(`${API_BASE}/api/verify/pending?limit=${BATCH}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (r.status === 401) { console.error("401 — VERIFY_TOKEN rejected by the Worker."); process.exit(3); }
  if (!r.ok) throw new Error(`pending HTTP ${r.status}`);
  return (await r.json()).candidates || [];
}

async function postResults(results) {
  if (!results.length) return;
  const r = await fetch(`${API_BASE}/api/verify/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ results }),
  });
  if (!r.ok) throw new Error(`result HTTP ${r.status}`);
}

// --- MX lookup ------------------------------------------------------------- //
async function mxHost(domain) {
  try {
    const mx = await resolver.resolveMx(domain);
    if (!mx.length) return null;
    mx.sort((a, b) => a.priority - b.priority);
    return mx[0].exchange;
  } catch {
    return null;
  }
}

// --- a minimal SMTP session, reused for a whole domain --------------------- //
// Opens one connection, says hello, then RCPT-probes each address (with RSET in
// between). Returns a map address -> { code, status }.
function smtpProbeDomain(mx, addresses) {
  return new Promise((resolve) => {
    const out = new Map();
    let buf = "";
    let catchAll = false;
    // Probe a guaranteed-bad address first (index 0) to detect catch-all servers,
    // then each real address. RSET clears the envelope, so we re-send MAIL FROM
    // before every RCPT — otherwise the server replies 503 "bad sequence".
    const catchAllAddr = `zzz-no-such-user-${Date.now()}@${domainOf(addresses[0])}`;
    const targets = [catchAllAddr, ...addresses];
    let ti = -1;
    let stage = "greet";

    const socket = net.createConnection({ host: mx, port: PORT });
    socket.setEncoding("utf8");
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    let done = false;
    const finish = () => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve({ results: out, catchAll }); };
    const send = (line) => socket.write(line + "\r\n");

    function classify(code) {
      if (code === 250 || code === 251) return "verified";
      if (code === 550 || code === 551 || code === 552 || code === 553) return "invalid";
      return "inconclusive"; // 4xx greylist, 5xx policy, etc.
    }

    function startTarget() {
      ti++;
      if (ti >= targets.length) { stage = "quit"; send("QUIT"); return; }
      stage = "mail"; send(`MAIL FROM:<${MAIL_FROM}>`);
    }

    socket.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        const m = /^(\d{3})([ -])/.exec(line);
        if (!m || m[2] === "-") continue; // wait for the final line of a multi-line reply
        handle(parseInt(m[1], 10));
      }
    });

    function handle(code) {
      switch (stage) {
        case "greet":
          if (code !== 220) return finish();
          stage = "ehlo"; send(`EHLO ${HELO_HOST}`); break;
        case "ehlo":
          if (code === 250) { startTarget(); break; }
          stage = "helo"; send(`HELO ${HELO_HOST}`); break;
        case "helo":
          if (code !== 250) return finish();
          startTarget(); break;
        case "mail":
          if (code !== 250) return finish(); // MAIL FROM refused → can't probe
          stage = "rcpt"; send(`RCPT TO:<${targets[ti]}>`); break;
        case "rcpt":
          if (ti === 0) catchAll = code === 250;               // catch-all probe
          else out.set(targets[ti], { code, status: classify(code) });
          stage = "rset"; send("RSET"); break;
        case "rset":
          startTarget(); break;                                 // RSET code ignored
        case "quit":
          return finish();
      }
    }

    socket.on("timeout", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

// --- main ------------------------------------------------------------------ //
async function onePass() {
  const candidates = await fetchPending();
  if (!candidates.length) { log("no pending candidates"); return 0; }
  log(`got ${candidates.length} candidates`);

  // group by domain
  const byDomain = new Map();
  for (const c of candidates) {
    const d = domainOf(c.address);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }

  const results = [];
  for (const [domain, list] of byDomain) {
    const mx = await mxHost(domain);
    if (!mx) {
      // No MX: can't receive mail at all -> every candidate here is invalid.
      for (const c of list) results.push({ id: c.id, status: "invalid", code: "no_mx" });
      log(`${domain}: no MX -> ${list.length} invalid`);
      continue;
    }
    const probeList = list.slice(0, MAX_PER_DOMAIN);
    const addrs = probeList.map((c) => c.address);
    let res;
    try {
      res = await smtpProbeDomain(mx, addrs);
    } catch {
      res = { results: new Map(), catchAll: false };
    }
    const byAddr = new Map(probeList.map((c) => [c.address, c]));
    let v = 0, inv = 0, ca = 0, inc = 0;
    for (const c of probeList) {
      const r = res.results.get(c.address);
      if (res.catchAll) {
        // Server accepts everything — can't trust a 250. Keep as probable.
        results.push({ id: c.id, status: "probable", code: "catchall" });
        ca++;
      } else if (!r) {
        results.push({ id: c.id, status: "probable", code: "smtp_inconclusive" });
        inc++;
      } else if (r.status === "verified") {
        results.push({ id: c.id, status: "verified", code: `smtp_${r.code}` });
        v++;
      } else if (r.status === "invalid") {
        results.push({ id: c.id, status: "invalid", code: `smtp_${r.code}` });
        inv++;
      } else {
        results.push({ id: c.id, status: "probable", code: `smtp_${r.code}` });
        inc++;
      }
    }
    // Candidates beyond MAX_PER_DOMAIN this pass: leave untouched (re-fetched later).
    void byAddr;
    log(`${domain} (mx ${mx})${res.catchAll ? " [catch-all]" : ""}: ${v} verified, ${inv} invalid, ${ca} catch-all, ${inc} inconclusive`);
    await sleep(SLEEP_MS);
  }

  await postResults(results);
  log(`wrote ${results.length} verdicts`);
  return results.length;
}

// Single-address diagnostic: `node verify.mjs --probe jane@acme.com`. Needs no
// API/token — handy for testing port-25 reachability and one address.
async function probeOne(addr) {
  const domain = domainOf(addr);
  const mx = await mxHost(domain);
  log(`domain ${domain} MX:`, mx || "(none)");
  if (!mx) { log("verdict: invalid (no MX)"); return; }
  const { results, catchAll } = await smtpProbeDomain(mx, [addr]);
  const r = results.get(addr);
  log(`catch-all: ${catchAll}`);
  log("verdict:", catchAll ? "probable (catch-all)" : r ? `${r.status} (SMTP ${r.code})` : "inconclusive (no reply)");
}

async function main() {
  const pi = process.argv.indexOf("--probe");
  if (pi !== -1) { await probeOne(process.argv[pi + 1]); return; }
  requireConfig();
  log(`verifier starting -> ${API_BASE} (from ${MAIL_FROM}, helo ${HELO_HOST}, port ${PORT})`);
  if (!WATCH) { await onePass(); return; }
  // watch mode: keep going until a pass returns nothing, then idle-poll.
  for (;;) {
    let n = 0;
    try { n = await onePass(); } catch (e) { log("pass error:", e.message); }
    await sleep(n > 0 ? 1000 : 60000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
