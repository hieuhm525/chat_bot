import { BotService, chunkText, hasPhoneNumber, NO_INFO, parseDraftRules, scoreRule, RuleCandidate, wantsHuman } from './bot.service';

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

  it('treats keywords as alternatives: one hit is enough', () => {
    const r = rule({ keywords: ['phí ship', 'tiền ship', 'ship bao nhiêu', 'phí vận chuyển'] });
    expect(scoreRule('tien ship sao shop', r)).toBeGreaterThan(0);
    expect(scoreRule('ship bn vậy', r)).toBeGreaterThan(0);
    expect(scoreRule('phí vận chuyển ra sao', r)).toBeGreaterThan(0);
    expect(scoreRule('giao hàng thế nào', r)).toBe(0);
  });

  it('scores the longest keyword hit, so a more specific match wins', () => {
    const r = rule({ keywords: ['mở cửa', 'giờ mở cửa'] });
    expect(scoreRule('giờ mở cửa', r)).toBe(3);
    expect(scoreRule('mấy giờ shop mở cửa', r)).toBe(2);
  });

  it('allows single-word keywords only in exact mode', () => {
    expect(scoreRule('menu', rule({ keywords: ['menu'] }))).toBe(0);
    expect(scoreRule('Menu!', rule({ keywords: ['menu'], matchMode: 'exact' }))).toBe(1);
    expect(scoreRule('xem menu', rule({ keywords: ['menu'], matchMode: 'exact' }))).toBe(0);
  });

  it('answers abbreviated, teencode and unaccented messages', () => {
    const r = rule({ keywords: ['phí ship'] });
    expect(scoreRule('phi ship bn vay shop', r)).toBeGreaterThan(0);
    expect(scoreRule('fí shipp bnh', r)).toBeGreaterThan(0);
    expect(scoreRule('fi sip sao shop', r)).toBeGreaterThan(0);
    expect(scoreRule('phi shjp', r)).toBe(0); // random typos are not guessed
    const transfer = rule({ keywords: ['chuyển khoản', 'số tài khoản'] });
    expect(scoreRule('cho e xin stk de ck', transfer)).toBeGreaterThan(0);
  });

  it('does not match inside another word', () => {
    expect(scoreRule('giagiao', rule({ keywords: ['giá giao'] }))).toBe(0);
  });
});

describe('wantsHuman', () => {
  it('catches requests for a person, with or without accents and in caps', () => {
    for (const text of ['Gặp nhân viên', 'cho em gap nhan vien voi', 'GẶP NGƯỜI THẬT!', 'cho mình gặp ad', 'mình muốn nói chuyện với người', 'không muốn nói chuyện với bot']) {
      expect(wantsHuman(text)).toBe(true);
    }
  });

  it('ignores questions that only mention staff', () => {
    for (const text of ['nhân viên giao hàng tới chưa', 'shop có mấy nhân viên', 'người mẫu mặc size gì', 'phí ship bao nhiêu']) {
      expect(wantsHuman(text)).toBe(false);
    }
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

  describe('rule with useAi', () => {
    const shirt = rule({ id: 'shirt', name: 'Tư vấn size', keywords: ['size gì'], priority: 30, answer: 'Bảng size áo: L 60-70kg', useAi: true, quickReplies: ['Đặt hàng'] });
    const trousers = rule({ id: 'trousers', name: 'Bảng size quần', keywords: ['quần size'], priority: 28, answer: 'Size quần: 34 (76-85kg)' });
    const fee = rule({ id: 'fee', name: 'Phí ship', keywords: ['phí ship'], answer: '30k' });
    const message = 'cao 1m72 nặng 81kg mặc quần size gì';
    const okLlm = () => ({ complete: jest.fn().mockResolvedValue({ text: 'Dạ anh lấy quần size 34 ạ.', provider: 'p', model: 'm', tokensIn: 1, tokensOut: 1, latencyMs: 5 }) });

    it('lets the LLM tailor the answer, with every matched rule as focus', async () => {
      const llm = okLlm();
      const service = new BotService({} as any, llm as any);
      const result = await service.resolve(bot, [shirt, trousers, fee], [{ role: 'user', content: message }], message);
      expect(result).toMatchObject({ text: 'Dạ anh lấy quần size 34 ạ.', source: 'llm', ruleId: 'shirt', quickReplies: ['Đặt hàng'] });
      const system: string = llm.complete.mock.calls[0][0][0].content;
      const focus = system.slice(system.indexOf('ưu tiên dùng chúng'), system.indexOf('Thông tin:'));
      expect(focus).toContain('Bảng size áo');
      expect(focus).toContain('Size quần: 34');
      expect(focus).not.toContain('Phí ship');
    });

    it('sends the rule verbatim when the LLM fails', async () => {
      const llm = { complete: jest.fn().mockRejectedValue(new Error('timeout')) };
      const service = new BotService({} as any, llm as any);
      const result = await service.resolve(bot, [shirt], [], message);
      expect(result).toMatchObject({ text: 'Bảng size áo: L 60-70kg', source: 'rule', ruleId: 'shirt' });
    });

    it('stays verbatim when the bot has AI turned off, and for rules without useAi', async () => {
      const llm = okLlm();
      const service = new BotService({} as any, llm as any);
      expect(await service.resolve({ ...bot, llmEnabled: false }, [shirt], [], message)).toMatchObject({ source: 'rule' });
      expect(await service.resolve(bot, [fee], [], 'phí ship bao nhiêu')).toMatchObject({ source: 'rule', text: '30k' });
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  it('lets the LLM answer order details even when the matched rule is verbatim-only', async () => {
    const llm = { complete: jest.fn().mockResolvedValue({ text: 'Dạ em tóm tắt đơn…', provider: 'p', model: 'm', tokensIn: 1, tokensOut: 1, latencyMs: 5 }) };
    const service = new BotService({} as any, llm as any);
    const jean = rule({ id: 'jean', name: 'Quần jean', keywords: ['quần jean'], answer: 'Quần jean 399k' });
    const order = 'Quần jean size 30\n1 cái\nHoàng Hiếu\n0988 123 123\n31a, ngõ 2';
    expect(await service.resolve(bot, [jean], [], order)).toMatchObject({ source: 'llm', ruleId: 'jean' });
    expect(await service.resolve(bot, [jean], [], 'quần jean giá bao nhiêu')).toMatchObject({ source: 'rule', text: 'Quần jean 399k' });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('spots phone numbers', () => {
    for (const t of ['0988123123', 'sđt 0988.123.123', '+84 988 123 123']) expect(hasPhoneNumber(t)).toBe(true);
    for (const t of ['size 30', 'eo 76cm 60-65kg', '31a, ngõ 2', '123456789012']) expect(hasPhoneNumber(t)).toBe(false);
  });

  describe('LLM without an answer', () => {
    const llmSaying = (text: string) => ({ complete: jest.fn().mockResolvedValue({ text, provider: 'p', model: 'm', tokensIn: 3, tokensOut: 1, latencyMs: 5 }) });

    it('counts the marker as a fallback and sends the shop fallback sentence', async () => {
      const service = new BotService({} as any, llmSaying(NO_INFO) as any);
      const result = await service.resolve(bot, [], [], 'shop có bán giày không');
      expect(result).toMatchObject({ text: bot.fallbackMessage, source: 'fallback', model: 'm' });
    });

    it('also catches a model that copies the fallback sentence instead of the marker', async () => {
      const service = new BotService({} as any, llmSaying('dạ em chưa có thông tin ạ') as any);
      expect(await service.resolve(bot, [], [], 'bán giày không')).toMatchObject({ source: 'fallback' });
    });

    it('falls back to the rule text when a useAi rule matched but the LLM has no answer', async () => {
      const service = new BotService({} as any, llmSaying(NO_INFO) as any);
      const r = rule({ useAi: true, answer: '8h-20h' });
      expect(await service.resolve(bot, [r], [], 'giờ mở cửa')).toMatchObject({ source: 'rule', text: '8h-20h' });
    });
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
