/**
 * Splits camelCase / PascalCase / acronym-prefixed identifiers into words.
 * Handles both ordinary camelCase ("mailingCity" -> "mailing City") and
 * acronym-then-word boundaries ("DBAName" -> "DBA Name", "FEINNumber" ->
 * "FEIN Number"), which a naive [a-z][A-Z] split misses.
 */
export function splitCamel(s: string): string {
  return s.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Lowercase, split camelCase, strip non-alphanumerics, collapse whitespace. */
export function normLabel(s: string): string {
  return splitCamel(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(s: string, minLen = 2): string[] {
  return normLabel(s)
    .split(" ")
    .filter((t) => t.length > minLen);
}

export function tokenOverlapScore(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  return overlap / Math.max(ta.size, tb.size);
}
