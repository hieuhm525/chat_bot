import { containsWords, normalizeText } from './normalize-text';

describe('normalizeText', () => {
  it('removes accents, punctuation and extra spaces', () => {
    expect(normalizeText('  Giờ MỞ CỬA?? ')).toBe('gio mo cua');
    expect(normalizeText('Đổi trả, bảo hành!')).toBe('doi tra bao hanh');
  });

  it('matches on word boundaries only', () => {
    expect(containsWords('shop mở cửa lúc 8h', 'mở cửa')).toBe(true);
    expect(containsWords('cửa hàng đóng', 'cửa')).toBe(true);
    expect(containsWords('không liên quan', 'quan')).toBe(true);
    expect(containsWords('giagiao', 'giá')).toBe(false);
  });

  it('matches unaccented customer input', () => {
    expect(containsWords('gio mo cua', 'giờ mở cửa')).toBe(true);
  });
});
