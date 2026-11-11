import { containsWords, normalizeText } from './normalize-text';

export interface OverlapRule {
  id: string;
  name: string;
  keywords: string[];
}

export interface Overlap {
  id: string;
  name: string;
  /** Keywords of the existing rule that collide with the draft. Empty when only the name matches. */
  shared: string[];
}

/**
 * Two keywords collide when one contains the other on word boundaries ("giao hàng" vs
 * "thời gian giao hàng"): a customer message hitting one will usually hit the other,
 * so both rules compete for the same question. Accent-insensitive, like the matcher.
 */
function keywordsCollide(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na.length < 3 || nb.length < 3) return false;
  return na === nb || containsWords(na, nb) || containsWords(nb, na);
}

/** Existing rules that cover the same topic as the draft, strongest overlap first. */
export function findOverlaps(draft: { name: string; keywords: string[] }, rules: OverlapRule[]): Overlap[] {
  const draftName = normalizeText(draft.name);
  const result: Array<Overlap & { score: number }> = [];
  for (const rule of rules) {
    const shared = rule.keywords.filter((k) => draft.keywords.some((d) => keywordsCollide(d, k)));
    const sameName = Boolean(draftName) && normalizeText(rule.name) === draftName;
    if (!shared.length && !sameName) continue;
    result.push({ id: rule.id, name: rule.name, shared, score: shared.length + (sameName ? 10 : 0) });
  }
  return result.sort((a, b) => b.score - a.score).map(({ score: _score, ...o }) => o);
}
