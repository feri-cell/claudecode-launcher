// Layer 4 — email finding (the Hunter.io replacement). This module holds the
// pure logic; the network side (homepage validation, MX lookup, site scraping)
// lives in crawl.ts/edgar.ts because it needs the request budget + rate gate.
//
// On Cloudflare Workers we cannot open an outbound SMTP socket on port 25, so
// the brief's "Option A — DNS+SMTP probe" is unavailable here. What we CAN do,
// all free and Worker-native, is:
//   • 4a domain resolution  — from the disclosed website, else a name heuristic
//                             validated by an MX record (DNS-over-HTTPS)
//   • 4b pattern generation — the eight industry-standard templates
//   • 4c verification       — Option C: scrape the site for mailto:/name-matched
//                             addresses (the only path to a 'verified' email here)
// Everything else is emitted as a best-guess "Guessed Email", flagged unverified.

// --- ASCII folding --------------------------------------------------------- //
// "JoséŸ-Ñoño" -> "joseynono". Strips accents (NFKD + combining marks) then
// keeps only [a-z0-9]; callers fold each name part separately.
export function asciiFold(raw: string): string {
  if (!raw) return "";
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// --- domain from a disclosed website --------------------------------------- //
// "https://www.Acme.com/investors" -> "acme.com". Returns null if unparseable.
export function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  let host: string;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : "https://" + website);
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!host.includes(".") || host.length < 4) return null;
  return host;
}

// --- name-heuristic domain guess ------------------------------------------- //
// "TerraCycle US Inc." -> "terracycle.com". Strips trailing entity suffixes and
// a leading "the", folds to a slug, appends .com. Best-effort; the caller MUST
// validate (MX/homepage) before trusting it — we never fabricate a verified URL.
const ENTITY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "lc", "corp", "corporation", "co", "company",
  "ltd", "limited", "lp", "llp", "plc", "pllc", "pc", "holdings", "holding",
  "group", "trust", "fund", "partners", "capital", "ventures", "management",
  "international", "global", "usa", "us", "the",
]);

export function guessDomain(companyName: string | null | undefined): string | null {
  if (!companyName) return null;
  // Drop a trailing "(CIK 000…)" suffix and punctuation, split into words.
  const cleaned = companyName.replace(/\(.*?\)/g, " ").replace(/[.,&/]+/g, " ");
  let words = cleaned.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  // Strip a leading "The" and trailing entity-type words.
  if (words.length && words[0].toLowerCase() === "the") words = words.slice(1);
  while (words.length > 1 && ENTITY_SUFFIXES.has(asciiFold(words[words.length - 1]))) {
    words = words.slice(0, -1);
  }
  const slug = words.map(asciiFold).join("");
  if (slug.length < 3) return null;
  return slug + ".com";
}

// --- 4b pattern generation ------------------------------------------------- //
// The eight templates in order of empirical frequency (brief §4b). Patterns that
// need a part we don't have (e.g. {last} with no surname) are skipped. Returned
// in priority order so the first surviving entry is the best "Guessed Email".
export interface EmailCandidate {
  address: string;
  pattern: string;
}

export function patternLocalParts(first: string, last: string): { pattern: string; local: string }[] {
  const f = asciiFold(first);
  const l = asciiFold(last);
  if (!f && !l) return [];
  const fi = f.slice(0, 1);
  const li = l.slice(0, 1);
  const all: { pattern: string; local: string; ok: boolean }[] = [
    { pattern: "first.last", local: `${f}.${l}`, ok: !!(f && l) },
    { pattern: "first", local: f, ok: !!f },
    { pattern: "f.last", local: `${fi}${l}`, ok: !!(fi && l) }, // {f}{last}
    { pattern: "first_last", local: `${f}_${l}`, ok: !!(f && l) },
    { pattern: "firstlast", local: `${f}${l}`, ok: !!(f && l) },
    { pattern: "last", local: l, ok: !!l },
    { pattern: "firstl", local: `${f}${li}`, ok: !!(f && li) },
    { pattern: "fdotlast", local: `${fi}.${l}`, ok: !!(fi && l) }, // {f}.{last}
  ];
  // De-dupe locals (e.g. single-name officers collapse several templates).
  const seen = new Set<string>();
  const out: { pattern: string; local: string }[] = [];
  for (const p of all) {
    if (!p.ok || !p.local || seen.has(p.local)) continue;
    seen.add(p.local);
    out.push({ pattern: p.pattern, local: p.local });
  }
  return out;
}

export function generatePatterns(first: string, last: string, domain: string): EmailCandidate[] {
  return patternLocalParts(first, last).map((p) => ({
    address: `${p.local}@${domain}`,
    pattern: p.pattern,
  }));
}

// --- 4c Option C: scrape addresses out of a page --------------------------- //
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Pull every address at `domain` from a page's HTML (mailto: hrefs and inline
// text both match the same regex). Lowercased + de-duped. Generic mailboxes
// (info@, sales@…) are kept here and filtered at the matching step.
export function extractEmailsAtDomain(html: string, domain: string): string[] {
  if (!html || !domain) return [];
  const d = domain.toLowerCase();
  const found = new Set<string>();
  for (const m of html.matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    const at = addr.lastIndexOf("@");
    const host = addr.slice(at + 1).replace(/^www\./, "");
    if (host === d || host.endsWith("." + d)) found.add(addr);
  }
  return [...found];
}

// Role / generic mailboxes that must never be matched to a person. A scraped
// address whose folded local-part is one of these is rejected outright.
const ROLE_LOCALPARTS = new Set([
  "info", "contact", "contactus", "sales", "support", "help", "hello", "hi",
  "admin", "office", "mail", "email", "team", "press", "media", "marketing",
  "careers", "jobs", "hr", "recruiting", "legal", "compliance", "privacy",
  "investors", "investor", "ir", "ventures", "general", "inquiries", "enquiries",
  "service", "services", "customerservice", "billing", "accounts", "accounting",
  "finance", "noreply", "donotreply", "webmaster", "postmaster", "abuse",
  "newsletter", "subscribe", "events", "partnerships", "partner", "bd",
]);

// Local-parts that combine BOTH the first and last name. Matching one of these
// exactly is the only basis for treating a scraped address as a person's — the
// weak `first`-only / `last`-only templates are deliberately excluded, since
// `john@` or `smith@` could belong to anyone at the domain.
export function strongLocalParts(first: string, last: string): Set<string> {
  const f = asciiFold(first), l = asciiFold(last);
  const fi = f.slice(0, 1), li = l.slice(0, 1);
  const s = new Set<string>();
  if (f && l) {
    s.add(`${f}.${l}`); s.add(`${f}_${l}`); s.add(`${f}${l}`);
    s.add(`${fi}${l}`); s.add(`${fi}.${l}`); s.add(`${f}${li}`);
    s.add(`${l}.${f}`); s.add(`${l}${f}`);
  }
  return s;
}

// Decide whether a scraped address belongs to a specific officer. STRICT: the
// folded local-part must (a) not be a role mailbox, and (b) either exactly equal
// one of the officer's first+last patterns, or contain BOTH the full surname
// (≥3 chars) and the first name (≥2 chars). Surname-substring alone is rejected
// — that was the source of bad "verified" matches.
export function matchOfficerEmail(
  scraped: string[],
  first: string,
  last: string
): string | null {
  const strong = strongLocalParts(first, last);
  const f = asciiFold(first), l = asciiFold(last);
  for (const addr of scraped) {
    const foldedLocal = asciiFold(addr.slice(0, addr.lastIndexOf("@")));
    if (!foldedLocal || ROLE_LOCALPARTS.has(foldedLocal)) continue;
    if (strong.has(foldedLocal)) return addr;
    if (l.length >= 3 && f.length >= 2 && foldedLocal.includes(l) && foldedLocal.includes(f)) return addr;
  }
  return null;
}

// --- domain-ownership confirmation ----------------------------------------- //
// A name-guessed domain (e.g. "Acme Holdings" -> acme.com) is worthless unless
// the site actually belongs to that company — an MX record alone doesn't prove
// it. We confirm by checking the homepage text contains the company's most
// distinctive name token. This is what stops us attaching emails scraped off an
// unrelated same-slug company.
const STOP_TOKENS = new Set([
  "inc", "incorporated", "llc", "lc", "corp", "corporation", "co", "company",
  "ltd", "limited", "lp", "llp", "plc", "pllc", "pc", "holdings", "holding",
  "group", "trust", "fund", "partners", "capital", "ventures", "management",
  "international", "global", "usa", "us", "the", "and", "of", "for", "a", "an",
  "real", "estate", "partners", "advisors", "associates", "services", "systems",
]);

export function companyTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const cleaned = name.replace(/\(.*?\)/g, " ").replace(/[.,&/]+/g, " ");
  const toks = cleaned.split(/\s+/).map(asciiFold).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
  // Longest tokens first — the most distinctive part of the name.
  return [...new Set(toks)].sort((a, b) => b.length - a.length);
}

// True if the page plausibly belongs to `name`: its most distinctive token (or
// the concatenated slug) appears in the page's folded text.
export function pageMentionsCompany(html: string, name: string | null | undefined): boolean {
  const toks = companyTokens(name);
  if (!toks.length) return false;
  const folded = asciiFold(html); // strips tags' angle brackets too, but tokens still match text
  if (folded.includes(toks.join(""))) return true;          // full slug, e.g. "terracycle"
  return toks.some((t) => t.length >= 4 && folded.includes(t)); // a distinctive word
}

// Site paths worth scraping for contact addresses, homepage first.
export const SCRAPE_PATHS = ["/", "/team", "/about", "/contact", "/leadership"];
