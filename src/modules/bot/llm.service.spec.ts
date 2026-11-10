import { decryptCredential } from '../../common/crypto';
import { LlmService } from './llm.service';

const key = Buffer.alloc(32, 7).toString('base64');

describe('LlmService.onModuleInit', () => {
  it('seeds LLM_PROVIDERS once with correct priority and encrypted keys', async () => {
    let inserted: any[] = [];
    const db = {
      select: () => ({ from: async () => [{ count: 0 }] }),
      insert: () => ({
        values: async (rows: any[]) => {
          inserted = rows;
        },
      }),
    };
    const config = {
      getOrThrow: (name: string) =>
        ({
          LLM_PROVIDERS: JSON.stringify([
            { name: 'first', baseUrl: 'https://first.example/v1', model: 'm1', apiKey: 'sk-first-1111' },
            { name: 'second', baseUrl: 'https://second.example/v1', model: 'm2', apiKey: 'sk-second-2222' },
          ]),
          CREDENTIAL_KEY: key,
          CREDENTIAL_KEY_ID: 'v1',
        })[name],
    };

    const service = new LlmService(db as any, config as any);
    await service.onModuleInit();

    expect(inserted).toHaveLength(2);
    expect(inserted.map((row) => row.name)).toEqual(['first', 'second']);
    expect(inserted.map((row) => row.priority)).toEqual([2, 1]);
    for (const row of inserted) expect(row.apiKeyEnc).not.toContain('sk-');
    expect(decryptCredential(inserted[0].apiKeyEnc, inserted[0].id, key)).toBe('sk-first-1111');
    expect(decryptCredential(inserted[1].apiKeyEnc, inserted[1].id, key)).toBe('sk-second-2222');
    expect(inserted.map((row) => row.keyId)).toEqual(['v1', 'v1']);
  });
});
