import { BotService, scoreRule, RuleCandidate } from './bot.service';

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
