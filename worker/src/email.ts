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

// Decide whether a scraped address belongs to a specific officer. We require the
// surname (folded, ≥3 chars) to appear in the local-part, or an exact match to
// one of that officer's generated pattern local-parts. This deliberately rejects
// role mailboxes like info@/contact@ — better blank than a wrong "verified".
export function matchOfficerEmail(
  scraped: string[],
  first: string,
  last: string
): string | null {
  const locals = new Set(patternLocalParts(first, last).map((p) => p.local));
  const l = asciiFold(last);
  for (const addr of scraped) {
    const local = addr.slice(0, addr.lastIndexOf("@")).toLowerCase();
    const foldedLocal = asciiFold(local);
    if (locals.has(local) || locals.has(foldedLocal)) return addr;
    if (l.length >= 3 && foldedLocal.includes(l)) return addr;
  }
  return null;
}

// Site paths worth scraping for contact addresses, homepage first.
export const SCRAPE_PATHS = ["/", "/team", "/about", "/contact", "/leadership"];
