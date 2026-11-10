/**
 * Vietnamese-friendly normalisation: lowercase, NFC, strip punctuation,
 * collapse whitespace, then remove diacritics. Customers type without accents
 * very often, so matching must be accent-insensitive.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'`~@#$%^&*_+=/\\|<>-]/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `needle` occurs in `haystack` on word boundaries. */
export function containsWords(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizeText(haystack));
}
