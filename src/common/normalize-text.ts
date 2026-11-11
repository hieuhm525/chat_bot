/**
 * Chat shorthand → full words, keyed by the accent-free form. Applied to both keywords and
 * customer messages, so "giá bn", "gia bao nhieu" and "giá bao nhiêu" all meet in the middle.
 * Only unambiguous-in-a-shop-chat tokens belong here: "bh" (bảo hành / bao giờ), "kh"
 * (không / khách hàng), "ng" (người / ngày) and single-letter pronouns are left alone on purpose.
 */
const ABBREVIATIONS: Record<string, string> = {
  k: 'khong',
  ko: 'khong',
  kg: 'khong',
  hk: 'khong',
  hok: 'khong',
  hong: 'khong',
  khum: 'khong',
  hem: 'khong',
  dc: 'duoc',
  j: 'gi',
  ji: 'gi',
  v: 'vay',
  z: 'vay',
  zay: 'vay',
  dzay: 'vay',
  r: 'roi',
  vs: 'voi',
  bn: 'bao nhieu',
  bnh: 'bao nhieu',
  bnhieu: 'bao nhieu',
  baonhieu: 'bao nhieu',
  nhiu: 'nhieu',
  ntn: 'nhu the nao',
  sp: 'san pham',
  tg: 'thoi gian',
  h: 'gio',
  dt: 'dien thoai',
  sdt: 'so dien thoai',
  stk: 'so tai khoan',
  tk: 'tai khoan',
  ck: 'chuyen khoan',
  km: 'khuyen mai',
  free: 'mien phi',
  freeship: 'mien phi ship',
  dchi: 'dia chi',
  ib: 'inbox',
  ad: 'admin',
  mn: 'moi nguoi',
  mk: 'minh',
  mik: 'minh',
  trc: 'truoc',
  thui: 'thoi',
  sz: 'size',
  cty: 'cong ty',
  hcm: 'ho chi minh',
  tphcm: 'ho chi minh',
  hn: 'ha noi',
};

/**
 * Vietnamese-friendly normalisation for matching: lowercase, NFC, strip punctuation, remove
 * diacritics, squash stretched letters ("shipppp"), then expand chat shorthand. Customers type
 * without accents and in abbreviations very often, so matching must not depend on either.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'`~@#$%^&*_+=/\\|<>-]/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    // Vietnamese never repeats a letter three times; digits are left alone ("1000").
    .replace(/([a-z])\1{2,}/g, '$1')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(' ');
}

/** True when `needle` occurs in `haystack` on word boundaries. */
export function containsWords(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizeText(haystack));
}
