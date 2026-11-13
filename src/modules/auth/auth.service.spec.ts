import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return { ...actual, verify: jest.fn(actual.verify) };
});

describe('AuthService.login', () => {
  it('runs argon2 verify even when the username does not exist (no timing leak)', async () => {
    const chain: any = {};
    for (const m of ['select', 'from', 'innerJoin', 'where']) chain[m] = () => chain;
    chain.limit = async () => []; // no such user
    const config: any = { getOrThrow: () => 'test' };
    const audit: any = { record: jest.fn() };
    const verify = argon2.verify as jest.Mock;

    const service = new AuthService(chain, config, audit);
    await expect(service.login('ghost', 'whatever123')).rejects.toBeInstanceOf(UnauthorizedException);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.login_failed', metadata: { reason: 'unknown_user' } }),
    );
  });
});
