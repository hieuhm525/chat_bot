import { decryptCredential, encryptCredential } from './crypto';

describe('credential encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const channelId = '11111111-1111-7111-8111-111111111111';

  it('round-trips a credential', () => {
    const blob = encryptCredential(JSON.stringify({ accessToken: 'secret' }), channelId, key, 'v1');
    expect(blob.startsWith('v1:v1:')).toBe(true);
    expect(JSON.parse(decryptCredential(blob, channelId, key))).toEqual({ accessToken: 'secret' });
  });

  it('binds the ciphertext to the channel id (AAD)', () => {
    const blob = encryptCredential('secret', channelId, key, 'v1');
    expect(() => decryptCredential(blob, '22222222-2222-7222-8222-222222222222', key)).toThrow();
  });
});
