export const ROLE_LABEL: Record<string, string> = { admin: 'Quản trị', owner: 'Chủ shop' };

/** "Hoàng Hiếu" / "hoang.hieu" → "HH"; a single word gives its first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}
