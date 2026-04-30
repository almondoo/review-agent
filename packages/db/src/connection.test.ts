import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postgresFactory = vi.hoisted(() => {
  const calls: { url: string; opts: Record<string, unknown> }[] = [];
  const endMock = vi.fn().mockResolvedValue(undefined);
  const fn = vi.fn((url: string, opts: Record<string, unknown>) => {
    calls.push({ url, opts });
    return Object.assign((..._args: unknown[]) => undefined, { end: endMock });
  });
  return { fn, calls, endMock };
});

vi.mock('postgres', () => ({
  default: postgresFactory.fn,
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({ marker: 'drizzle-instance' })),
}));

let createDbClient: typeof import('./connection.js').createDbClient;

beforeEach(async () => {
  postgresFactory.calls.length = 0;
  postgresFactory.fn.mockClear();
  postgresFactory.endMock.mockClear();
  ({ createDbClient } = await import('./connection.js'));
});

afterEach(() => {
  vi.resetModules();
});

describe('createDbClient', () => {
  it('passes url + sane defaults to postgres driver', () => {
    createDbClient({ url: 'postgres://u:p@h/db' });
    const call = postgresFactory.calls[0];
    expect(call?.url).toBe('postgres://u:p@h/db');
    expect(call?.opts).toMatchObject({
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    });
    expect(call?.opts).not.toHaveProperty('ssl');
  });

  it('forwards explicit pool sizing + timeouts', () => {
    createDbClient({
      url: 'postgres://u:p@h/db',
      max: 5,
      idleTimeout: 5,
      connectTimeout: 2,
    });
    expect(postgresFactory.calls[0]?.opts).toMatchObject({
      max: 5,
      idle_timeout: 5,
      connect_timeout: 2,
    });
  });

  it('passes ssl through only when set', () => {
    createDbClient({ url: 'postgres://u:p@h/db', ssl: 'require' });
    expect(postgresFactory.calls[0]?.opts).toHaveProperty('ssl', 'require');
  });

  it('returns a close fn that ends the underlying pool', async () => {
    const { close } = createDbClient({ url: 'postgres://u:p@h/db' });
    await close();
    expect(postgresFactory.endMock).toHaveBeenCalledOnce();
  });
});
