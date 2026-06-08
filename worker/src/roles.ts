// Officer role normalization and ranking (ported from msc_edgar/roles.py).
// A normalized-substring matcher maps free-text roles to a seniority priority
// (lower = more senior). Keys are matched LONGEST-FIRST so "President and CEO"
// resolves to CEO (1), not President (2).

export const OFFICER_ROLE_PRIORITY: Record<string, number> = {
  "chief executive officer": 1, "president and ceo": 1, "president & ceo": 1, "ceo": 1,
  "president": 2,
  "co-founder": 3, "founder": 3,
  "chairman": 4, "chairperson": 4, "chair": 4,
  "chief financial officer": 5, "cfo": 5,
  "chief operating officer": 6, "coo": 6,
  "general counsel": 7, "chief legal officer": 7,
  "secretary": 8,
  "executive officer": 9,
  "director": 10,
};
export const ROLE_PRIORITY_UNKNOWN = 99;
export const TOP_N_OFFICERS = 3;

// Longest key first for substring matching.
const ROLE_KEYS = Object.keys(OFFICER_ROLE_PRIORITY).sort((a, b) => b.length - a.length);

const ROLE_HINTS = [
  "chief", "officer", "president", "ceo", "cfo", "coo", "cto", "director",
  "chairman", "chairperson", "chair", "founder", "secretary", "treasurer",
  "general counsel", "managing member", "manager", "partner", "principal",
  "vice president", "vp", "trustee", "executive",
];

export function normalizeRole(role: string): string {
  if (!role) return "";
  let s = role.toLowerCase().replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function rolePriority(role: string): number {
  const norm = normalizeRole(role);
  if (!norm) return ROLE_PRIORITY_UNKNOWN;
  for (const key of ROLE_KEYS) {
    if (norm.includes(key)) return OFFICER_ROLE_PRIORITY[key];
  }
  return ROLE_PRIORITY_UNKNOWN;
}

export function looksLikeRole(text: string): boolean {
  const norm = normalizeRole(text);
  return ROLE_HINTS.some((h) => norm.includes(h));
}
