// Layer 3 — officer extraction (ported from msc_edgar/officers.py).
// Three parsers behind one router: Form D XML, 1-A/253G HTML, S/F-series HTML.
// Keeps the two fixes from the Python build:
//   * the signature regex matches a bare role keyword ("Name, Director"), and
//   * sourceTypeForForm strips the amendment suffix so "D/A" uses the XML parser.

import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import { rolePriority, looksLikeRole } from "./roles";

// --- Name handling / false-positive rejection ------------------------------ //
const REJECT_TOKENS = new Set([
  "inc", "llc", "l.l.c", "corp", "corporation", "ltd", "limited", "lp", "l.p",
  "llp", "plc", "company", "co", "holdings", "holding", "trust", "fund", "group",
  "partners", "capital", "ventures", "management", "advisors", "associates",
  "bank", "na", "n.a", "sa", "ag", "gmbh", "pllc", "pc",
]);
const US_STATES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
  "nebraska", "nevada", "hampshire", "jersey", "mexico", "york", "carolina",
  "dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode", "tennessee",
  "texas", "utah", "vermont", "virginia", "washington", "wisconsin", "wyoming",
]);
const NAME_RE = /^[A-Z][A-Za-z.'\-]+(?:\s+(?:[A-Z]\.?|[A-Z][A-Za-z.'\-]+)){1,3}$/;

export function isPersonName(text: string): boolean {
  if (!text) return false;
  const name = text.replace(/\s+/g, " ").trim().replace(/,+$/, "");
  if (!NAME_RE.test(name)) return false;
  const toks = name.split(" ").map((t) => t.toLowerCase().replace(/\.+$/g, "").replace(/^\.+/g, ""));
  if (toks.length < 2) return false;
  if (toks.some((t) => REJECT_TOKENS.has(t))) return false;
  if (toks.some((t) => US_STATES.has(t))) return false;
  return true;
}

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

export function splitName(full: string): [string, string] {
  let parts = full.replace(/\s+/g, " ").trim().replace(/,+$/, "").split(" ").filter(Boolean);
  // Drop a trailing generational suffix so "John Smith Jr." → last name "Smith".
  if (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    parts = parts.slice(0, -1);
  }
  if (!parts.length) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts[parts.length - 1]];
}

export interface Officer {
  full_name: string;
  first: string;
  last: string;
  role: string;
  source_type: string;
  role_priority: number;
}

export function makeOfficer(fullName: string, role: string, sourceType: string): Officer | null {
  const cleaned = (fullName || "").replace(/\s+/g, " ").trim().replace(/,+$/, "");
  if (!isPersonName(cleaned)) return null;
  const [first, last] = splitName(cleaned);
  if (!last) return null;
  const r = (role || "").trim();
  return { full_name: cleaned, first, last, role: r, source_type: sourceType, role_priority: rolePriority(r) };
}

// --- Parser 1 — Form D XML ------------------------------------------------- //
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function collectByTag(node: any, tag: string, out: any[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectByTag(n, tag, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === tag) {
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
      collectByTag(v, tag, out);
    }
  }
}

function textValues(node: any, tag: string): string[] {
  const raw: any[] = [];
  collectByTag(node, tag, raw);
  return raw
    .map((v) => (typeof v === "string" ? v : v && typeof v === "object" && v["#text"] ? String(v["#text"]) : ""))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFormDXml(xml: string): Officer[] {
  let doc: any;
  try {
    doc = xmlParser.parse(xml);
  } catch {
    return [];
  }
  const persons: any[] = [];
  collectByTag(doc, "relatedPersonInfo", persons);

  const officers: Officer[] = [];
  for (const person of persons) {
    const first = textValues(person, "firstName")[0] ?? "";
    const middle = textValues(person, "middleName")[0] ?? "";
    const last = textValues(person, "lastName")[0] ?? "";
    if (!first || !last) continue;
    const full = [first, middle, last].filter(Boolean).join(" ");

    const clar = textValues(person, "relationshipClarification")[0] ?? "";
    const rels = textValues(person, "relationship");
    let role = "";
    if (clar) role = clar;
    else if (rels.length) role = rels.reduce((a, b) => (rolePriority(b) < rolePriority(a) ? b : a));

    const off = makeOfficer(full, role, "formd_xml");
    if (off) officers.push(off);
  }
  return officers;
}

// --- Parser 2/3 — HTML (1-A / 253G / 1-K / 1-SA / S / F-series) ------------- //
// Reg A+ filings are free-form HTML, so recall depends entirely on how the
// issuer laid the document out. We run THREE complementary passes and union the
// results, leaning on isPersonName()/makeOfficer() to keep precision high.
const NAME_TOKEN = "[A-Z][A-Za-z.'\\-]+";
const NAME_PAT = `${NAME_TOKEN}(?:\\s+(?:${NAME_TOKEN}|[A-Z]\\.))(?:\\s+(?:${NAME_TOKEN}|[A-Z]\\.|Jr\\.?|Sr\\.?|II|III|IV)){0,3}`;
// A role keyword covering the same vocabulary as roles.ts ROLE_HINTS so the two
// stay in agreement (multi-word titles first so the regex prefers the longest).
const ROLE_KW =
  "(?:Chief\\s+[A-Za-z]+\\s+Officer|Chief\\s+Executive|Chief\\s+Financial|Chief\\s+Operating|" +
  "Executive\\s+Officer|Vice\\s+President|General\\s+Counsel|Chief\\s+Legal\\s+Officer|" +
  "Managing\\s+(?:Member|Director|Partner)|Co-?Founder|" +
  "President|Director|Chairman|Chairperson|Chair|Secretary|Treasurer|Counsel|" +
  "Manager|Member|Founder|Principal|Partner|Trustee|Owner|" +
  "CEO|CFO|COO|CTO)";
// "/s/ John Smith, Chief Executive Officer" — separator may be a comma, dash, or
// just whitespace before the title (EDGAR signature pages vary widely).
const SIG_RE = new RegExp(
  `(?:/s/\\s*)?(${NAME_PAT})\\s*[,\\-–—]\\s*((?:[A-Z][A-Za-z]+[ &/]+)*${ROLE_KW})`,
  "g"
);
// Signature-block label pairs: "Name: John Smith … Title: Chief Executive
// Officer" (very common on 1-A / 1-K signature pages and in Item 10 prose).
const NAMETITLE_RE = new RegExp(
  `Name\\s*[:\\-]\\s*(${NAME_PAT})[\\s\\S]{0,80}?Title\\s*[:\\-]\\s*([A-Z][A-Za-z][A-Za-z &/\\-]{2,60})`,
  "g"
);

function cellText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseHtmlOfficers(html: string, sourceType: string): Officer[] {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false } });
  const found = new Map<string, Officer>();
  const add = (name: string, role: string) => {
    const off = makeOfficer(name, role, sourceType);
    if (off && !found.has(off.full_name.toLowerCase())) found.set(off.full_name.toLowerCase(), off);
  };

  // 1) Tables: pair EVERY name-like cell in a row with its nearest role-like
  //    cell, so multi-person rows ("Jane Doe | CEO | John Roe | CFO") aren't
  //    collapsed to a single contact the way a one-name-per-row scan would.
  for (const row of root.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td, th").map((c) => cellText(c.text));
    const nameIdx = cells.map((c, i) => (isPersonName(c) ? i : -1)).filter((i) => i >= 0);
    const roleIdx = cells.map((c, i) => (looksLikeRole(c) ? i : -1)).filter((i) => i >= 0);
    for (const ni of nameIdx) {
      let best = -1;
      let bestDist = Infinity;
      for (const ri of roleIdx) {
        if (ri === ni) continue;
        const d = Math.abs(ri - ni);
        // On a tie, prefer the role to the RIGHT of the name — tables read
        // "Name, Title", so in "Jane | CEO | John | CFO" John pairs with CFO.
        if (d < bestDist || (d === bestDist && ri > ni && best < ni)) {
          bestDist = d;
          best = ri;
        }
      }
      if (best >= 0) add(cells[ni], cells[best]);
    }
  }

  const text = root.structuredText;
  // 2) Signature lines: "Name, Role" / "/s/ Name - Role".
  for (const m of text.matchAll(SIG_RE)) add(m[1], m[2]);
  // 3) Label pairs: "Name: … Title: …".
  for (const m of text.matchAll(NAMETITLE_RE)) {
    if (looksLikeRole(m[2])) add(m[1], m[2]);
  }

  return [...found.values()];
}

// --- Router ---------------------------------------------------------------- //
export function sourceTypeForForm(formType: string): string {
  // Strip the amendment suffix: "D/A" and "1-A/A" share their base form's docs.
  const base = (formType || "").toUpperCase().split("/")[0];
  if (base === "D") return "formd_xml";
  if (base.startsWith("1-A") || base.startsWith("253G")) return "html_1a";
  return "html_sf";
}

export function parseDocument(formType: string, content: string): Officer[] {
  const st = sourceTypeForForm(formType);
  if (st === "formd_xml") return parseFormDXml(content);
  return parseHtmlOfficers(content, st);
}
