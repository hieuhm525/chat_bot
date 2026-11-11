import { splitReply, typingDelayMs } from './reply-pacing';

describe('splitReply', () => {
  it('keeps a short reply as one message', () => {
    expect(splitReply('  Dạ shop mở cửa 8h-22h ạ.  ', 2000)).toEqual(['Dạ shop mở cửa 8h-22h ạ.']);
  });

  it('returns nothing for a blank reply', () => {
    expect(splitReply('   ', 2000)).toEqual([]);
  });

  it('splits a long reply at paragraph breaks', () => {
    const a = 'A'.repeat(300);
    const b = 'B'.repeat(300);
    expect(splitReply(`${a}\n\n${b}`, 2000)).toEqual([a, b]);
  });

  it('packs small paragraphs together instead of sending one bubble each', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Đoạn ${i} ${'x'.repeat(60)}`);
    const chunks = splitReply(paragraphs.join('\n\n'), 2000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(paragraphs.join('\n\n'));
  });

  it('never exceeds the provider limit, even for one huge paragraph', () => {
    const sentence = 'Đây là một câu khá dài để kiểm tra việc cắt. ';
    const chunks = splitReply(sentence.repeat(200), 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(sentence.repeat(200).trim().replace(/\s+/g, ' '));
  });

  it('falls back to bigger bubbles when splitting would give too many messages', () => {
    const paragraphs = Array.from({ length: 10 }, () => 'y'.repeat(450));
    const chunks = splitReply(paragraphs.join('\n\n'), 2000);
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });

  it('cuts a word with no spaces at the hard limit', () => {
    const chunks = splitReply('z'.repeat(2500), 1000);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});

describe('typingDelayMs', () => {
  it('waits at least 0.8s and at most 3s', () => {
    expect(typingDelayMs('ok')).toBe(800);
    expect(typingDelayMs('x'.repeat(5000))).toBe(3000);
    expect(typingDelayMs('x'.repeat(100))).toBe(2100);
  });
});
