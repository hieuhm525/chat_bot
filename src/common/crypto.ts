import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Credential at-rest format: v1:<keyId>:<base64(nonce | ciphertext | tag)>
 * AAD binds the ciphertext to one channel id, so a copied blob cannot be
 * replayed for another channel.
 */
export function encryptCredential(plain: string, channelId: string, keyB64: string, keyId: string): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_KEY must decode to 32 bytes');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(channelId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${keyId}:${Buffer.concat([nonce, ct, tag]).toString('base64')}`;
}

export function decryptCredential(blob: string, channelId: string, keyB64: string): string {
  const parts = blob.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported credential format');
  const raw = Buffer.from(parts[2], 'base64');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce);
  decipher.setAAD(Buffer.from(channelId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
