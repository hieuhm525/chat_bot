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

  it('expands chat shorthand and squashes stretched letters', () => {
    expect(normalizeText('sp này giá bn v shop')).toBe('san pham nay gia bao nhieu vay shop');
    expect(normalizeText('ship ko? ck dc hk')).toBe('ship khong chuyen khoan duoc khong');
    expect(normalizeText('freeship k ạaaa')).toBe('mien phi ship khong a');
    expect(normalizeText('shipppp 1000đ')).toBe('ship 1000d');
    expect(normalizeText('fí síp bnhiu')).toBe('phi ship bao nhieu');
    expect(normalizeText('somi, quần jin, hudi')).toBe('so mi quan jean hoodie');
  });

  it('is idempotent, since matching normalizes already-normalized text again', () => {
    for (const s of ['tg giao bn ngày', 'sdt shop', 'free ship hcm', 'mấy h mở cửa']) {
      expect(normalizeText(normalizeText(s))).toBe(normalizeText(s));
    }
  });

  it('matches abbreviated customer input against full keywords and vice versa', () => {
    expect(containsWords('tg giao hàng bn ngày', 'thời gian giao hàng')).toBe(true);
    expect(containsWords('cho xin số điện thoại', 'sdt')).toBe(true);
    expect(containsWords('giá bnh', 'bao nhiêu')).toBe(true);
  });
});
