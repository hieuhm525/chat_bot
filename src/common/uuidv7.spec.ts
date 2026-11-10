import { uuidv7 } from './uuidv7';

describe('uuidv7', () => {
  it('is a valid v7 uuid and sorts by time', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(1_700_000_001_000);
    const first = uuidv7();
    const second = uuidv7();
    now.mockRestore();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second > first).toBe(true);
  });
});
