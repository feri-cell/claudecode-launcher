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
