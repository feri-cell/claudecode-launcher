// Layer 1 — EFTS hit parsing + the regulation→forms map (ported from
// msc_edgar/discovery.py and config.py). The critical rule: the issuer CIK is
// _source.ciks[0], NEVER the accession's filer-agent segment.

export const REGULATION_FORMS: Record<string, string[]> = {
  "A+": ["1-A", "1-A/A", "253G1", "253G2", "253G3", "253G4"],
  "D": ["D"],
  "S": ["F-1", "F-1/A", "F-3", "F-3/A"],
  "144A": ["S-1", "S-1/A", "S-3", "S-3/A", "F-4", "F-4/A"],
};

// Earliest electronic-filing year per form on EDGAR/EFTS. "Everything EDGAR has"
// is bounded by these — backfilling earlier returns nothing.
export function formStartYear(form: string): number {
  const f = form.toUpperCase();
  if (f === "D") return 2008;                       // Form D electronic from 2008
  if (f.startsWith("1-A") || f.startsWith("253G")) return 2015; // Reg A+ (JOBS Act)
  return 2001;                                      // EFTS full-text starts 2001
}

export interface FilingRecord {
  accession: string;
  cik: number; // issuer CIK, leading zeros stripped
  companyName: string;
  formType: string;
  filingDate: string; // YYYY-MM-DD
  primaryDoc: string | null;
}

const CIK_SUFFIX_RE = /\s*\(CIK\s*\d+\)\s*$/i;

export function cleanCompanyName(displayName: string): string {
  const name = (displayName || "").replace(CIK_SUFFIX_RE, "");
  return name.replace(/\s+/g, " ").trim();
}

// Turn one EFTS hit into a FilingRecord, or null if it lacks an issuer CIK.
export function parseHit(hit: any, formFallback?: string): FilingRecord | null {
  const src = hit?._source ?? {};
  const ciks: any[] = src.ciks ?? [];
  if (!ciks.length) return null;
  const issuerCik = parseInt(String(ciks[0]).replace(/^0+/, "") || "0", 10);
  if (!issuerCik) return null;

  const id = String(hit?._id ?? "");
  const accession = src.adsh ?? id.split(":", 1)[0];
  const primaryDoc = id.includes(":") ? id.slice(id.indexOf(":") + 1) : null;

  const names: string[] = src.display_names ?? [""];
  return {
    accession,
    cik: issuerCik,
    companyName: cleanCompanyName(names[0] ?? ""),
    formType: src.form ?? formFallback ?? "",
    filingDate: src.file_date ?? "",
    primaryDoc,
  };
}
