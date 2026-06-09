// Layer 2 — company enrichment parsing (ported from msc_edgar/company.py).
// The submissions JSON website field is almost always empty; we keep it only
// when present and never fabricate a URL.

export const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json";

export function submissionsUrl(cik: number): string {
  return SUBMISSIONS_URL.replace("{cik10}", String(cik).padStart(10, "0"));
}

export function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url || ["n/a", "none", "-"].includes(url.toLowerCase())) return null;
  if (!url.includes(".")) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

export interface CompanyFields {
  name: string | null;
  sic: string | null;
  sicDescription: string | null;
  state: string | null;
  website: string | null;
  websiteSource: "verified" | "unknown";
}

export function parseSubmissions(j: any): CompanyFields {
  const website = normalizeWebsite(j?.website) ?? normalizeWebsite(j?.investorWebsite);
  return {
    name: (j?.name ?? "").trim() || null,
    sic: j?.sic ? String(j.sic).trim() || null : null,
    sicDescription: (j?.sicDescription ?? "").trim() || null,
    state: (j?.stateOfIncorporation ?? "").trim() || null,
    website,
    websiteSource: website ? "verified" : "unknown",
  };
}

// --- segmentation: operating company vs SPV / fund / shell ----------------- //
// A large share of EDGAR filers (especially Form D) are investment vehicles with
// no web/email footprint — finding an email for them is impossible for us OR for
// Hunter.io. Classifying them lets the pipeline prioritise real operating
// companies for email finding and lets the dashboard filter outreach lists.
//
// Returns 1 (operating), 0 (SPV/fund/shell), or null (unknown — no signal).

// SEC SIC codes for investment vehicles / blank-check / holding shells.
const INVESTMENT_SIC = new Set([
  "6770", // blank checks (SPACs)
  "6726", // investment offices, NEC
  "6722", // management investment, open-end
  "6799", // investors, NEC
  "6221", // commodity contracts brokers/dealers
  "6189", // asset-backed securities
  "6199", // finance services
  "6200", // security & commodity brokers
]);

// Name markers that almost always denote a pass-through vehicle, not an operating
// business: "… a Series of …", SPVs, named funds, single-asset LPs.
const SPV_NAME_RE =
  /\b(a series of|series\s+[a-z0-9]+\s+of|spv\b|special purpose|blank check|acquisition corp|fund\s+(?:[ivxl]+|[0-9]+|[a-z])\b|capital partners|venture partners|opportunit(?:y|ies) fund|master fund|feeder fund)\b/i;
const LP_TAIL_RE = /\b(l\.?\s?p\.?|llp)\.?\s*$/i;

export function classifyOperating(
  name: string | null | undefined,
  sic: string | null | undefined
): 0 | 1 | null {
  const sicStr = (sic ?? "").trim();
  if (sicStr && INVESTMENT_SIC.has(sicStr)) return 0;
  const n = (name ?? "").trim();
  if (n) {
    if (SPV_NAME_RE.test(n)) return 0;
    if (LP_TAIL_RE.test(n) && !sicStr) return 0; // bare "… LP" with no real SIC
    if (sicStr) return 1; // has a real (non-investment) SIC and no SPV name → operating
  }
  // A real, non-investment SIC code is a strong operating signal even if the name
  // is unremarkable.
  if (sicStr) return 1;
  return null; // no usable signal yet
}
