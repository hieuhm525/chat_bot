import { BotService, chunkText, parseDraftRules, scoreRule, RuleCandidate } from './bot.service';

const rule = (over: Partial<RuleCandidate> = {}): RuleCandidate => ({
  id: 'r1',
  name: 'Giờ mở cửa',
  keywords: ['giờ mở cửa', 'mở cửa'],
  matchMode: 'contains',
  priority: 10,
  answer: '8h-20h',
  enabled: true,
  ...over,
});

describe('scoreRule', () => {
  it('matches accented and unaccented text', () => {
    expect(scoreRule('giờ mở cửa khi nào', rule())).toBeGreaterThan(0);
    expect(scoreRule('gio mo cua khi nao', rule())).toBeGreaterThan(0);
  });

  it('ignores short keywords and single-word matches', () => {
    expect(scoreRule('cửa hàng đóng', rule({ keywords: ['cửa'] }))).toBe(0);
    expect(scoreRule('abc', rule({ keywords: ['ab'] }))).toBe(0);
  });

  it('requires 60% of keywords', () => {
    const r = rule({ keywords: ['giao hàng', 'phí ship', 'hỏa tốc'] });
    expect(scoreRule('giao hàng thế nào', r)).toBe(0);
    expect(scoreRule('giao hàng và phí ship', r)).toBeGreaterThan(0);
  });

  it('answers abbreviated and unaccented messages', () => {
    const r = rule({ keywords: ['phí ship', 'bao nhiêu'] });
    expect(scoreRule('phi ship bn vay shop', r)).toBeGreaterThan(0);
    expect(scoreRule('fí shipp bnh', r)).toBe(0); // "fí" is not "phí": no guessing at misspellings
    const transfer = rule({ keywords: ['chuyển khoản', 'số tài khoản'] });
    expect(scoreRule('cho e xin stk de ck', transfer)).toBeGreaterThan(0);
  });

  it('does not match inside another word', () => {
    expect(scoreRule('giagiao', rule({ keywords: ['giá giao'] }))).toBe(0);
  });
});

describe('BotService.resolve', () => {
  const bot = {
    name: 'CSKH',
    llmEnabled: true,
    fallbackMessage: 'Dạ em chưa có thông tin ạ.',
    greeting: '',
    handoffMessage: '',
  } as any;

  it('returns the matched rule id', async () => {
    const service = new BotService({} as any, { enabled: false } as any);
    const result = await service.resolve(bot, [rule()], [], 'giờ mở cửa');
    expect(result).toMatchObject({ source: 'rule', text: '8h-20h', ruleId: 'r1' });
  });

  it('returns llm usage metadata', async () => {
    const llm = {
      enabled: true,
      complete: jest.fn().mockResolvedValue({
        text: 'Dạ em giúp được ạ.',
        provider: 'local',
        model: 'm1',
        tokensIn: 11,
        tokensOut: 7,
        latencyMs: 42,
      }),
    };
    const service = new BotService({} as any, llm as any);
    const result = await service.resolve(bot, [], [], 'xin chào');
    expect(result).toEqual({
      text: 'Dạ em giúp được ạ.',
      source: 'llm',
      model: 'm1',
      provider: 'local',
      tokensIn: 11,
      tokensOut: 7,
      latencyMs: 42,
    });
  });
});

describe('parseDraftRules', () => {
  it('reads a fenced JSON array and drops invalid items and short keywords', () => {
    const raw = [
      'Đây là kết quả:',
      '```json',
      JSON.stringify([
        { name: 'Phí ship', keywords: ['phí ship', 'ab', 'phí ship'], answer: '30k' },
        { name: 'Thiếu answer', keywords: ['giao hàng'] },
        { name: 'Không keyword', keywords: ['ab'], answer: 'x' },
      ]),
      '```',
    ].join('\n');
    expect(parseDraftRules(raw)).toEqual([{ name: 'Phí ship', keywords: ['phí ship'], answer: '30k' }]);
  });

  it('returns null for unusable output', () => {
    expect(parseDraftRules('xin lỗi, em không làm được')).toBeNull();
    expect(parseDraftRules('[{oops')).toBeNull();
  });
});

describe('chunkText', () => {
  it('keeps paragraphs whole and splits oversized ones', () => {
    expect(chunkText('a\n\nb', 10)).toEqual(['a\n\nb']);
    expect(chunkText('aaaa\n\nbbbb', 6)).toEqual(['aaaa', 'bbbb']);
    expect(chunkText('x'.repeat(12), 5)).toEqual(['xxxxx', 'xxxxx', 'xx']);
    expect(chunkText('  \n\n ')).toEqual([]);
  });
});

describe('BotService.generateRules', () => {
  const dbWith = (existing: Array<{ id: string; name: string }>) => {
    let call = 0;
    const query = (rows: unknown[]) => {
      const q: any = { from: () => q, where: () => q, limit: () => Promise.resolve(rows), then: (r: any) => Promise.resolve(rows).then(r) };
      return q;
    };
    // First select is getActiveBot, second loads existing rule names.
    return { select: () => query(call++ === 0 ? [{ id: 'b1' }] : existing) } as any;
  };

  it('drops drafts repeating a topic from another chunk', async () => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify([
          { name: 'Giờ mở cửa', keywords: ['giờ mở cửa'], answer: '8h-20h' },
          { name: 'Gio mo cua', keywords: ['mở cửa'], answer: 'trùng' },
          { name: 'Đổi trả', keywords: ['đổi trả'], answer: '7 ngày' },
        ]),
      }),
    };
    const service = new BotService(dbWith([]), llm as any);
    const { items } = await service.generateRules('w1', 'b1', 'tài liệu');
    expect(items.map((i) => i.name)).toEqual(['Giờ mở cửa', 'Đổi trả']);
    expect(llm.complete.mock.calls[0][1]).toMatchObject({ maxTokens: expect.any(Number) });
  });

  it('fails when no chunk yields valid JSON', async () => {
    const llm = { complete: jest.fn().mockResolvedValue({ text: 'không biết' }) };
    const service = new BotService(dbWith([]), llm as any);
    await expect(service.generateRules('w1', 'b1', 'tài liệu')).rejects.toThrow('LLM không trả về');
  });
});
