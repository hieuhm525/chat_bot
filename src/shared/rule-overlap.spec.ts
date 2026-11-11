import { findOverlaps } from './rule-overlap';

const existing = [
  { id: 'ship', name: 'Giao hàng', keywords: ['giao hàng', 'ship', 'phí ship', 'vận chuyển'] },
  { id: 'open', name: 'Giờ mở cửa', keywords: ['giờ mở cửa', 'mở cửa', 'làm việc'] },
  { id: 'pay', name: 'Thanh toán', keywords: ['thanh toán', 'chuyển khoản', 'cod'] },
];

describe('findOverlaps', () => {
  it('catches a renamed topic through shared or contained keywords', () => {
    expect(findOverlaps({ name: 'Phí vận chuyển', keywords: ['phí vận chuyển', 'phi ship'] }, existing)).toEqual([
      { id: 'ship', name: 'Giao hàng', shared: ['ship', 'phí ship', 'vận chuyển'] },
    ]);
    expect(findOverlaps({ name: 'Thời gian giao', keywords: ['thời gian giao hàng', 'mấy ngày'] }, existing)).toEqual([
      { id: 'ship', name: 'Giao hàng', shared: ['giao hàng'] },
    ]);
  });

  it('flags a same-name rule even without shared keywords, ranked first', () => {
    const result = findOverlaps({ name: 'thanh toan', keywords: ['mở cửa'] }, existing);
    expect(result.map((o) => o.id)).toEqual(['pay', 'open']);
  });

  it('ignores unrelated topics and partial words', () => {
    expect(findOverlaps({ name: 'Đổi trả', keywords: ['đổi trả', 'hoàn tiền'] }, existing)).toEqual([]);
    expect(findOverlaps({ name: 'Shipper', keywords: ['shipper giao'] }, existing)).toEqual([]);
  });
});
