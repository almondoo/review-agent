import { describe, expect, it, vi } from 'vitest';
import type { AppAuthClient } from './app-auth.js';
import { build401RetryHandler, createAppOctokitFactory } from './app-octokit.js';

describe('createAppOctokitFactory', () => {
  it('mints token via auth client and constructs an Octokit', async () => {
    const authClient: AppAuthClient = {
      getInstallationToken: vi.fn().mockResolvedValue({
        token: 'inst-tok',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      invalidate: vi.fn(),
    };
    const factory = createAppOctokitFactory({ authClient, userAgent: 'test/1' });
    const octokit = await factory(99n);

    expect(authClient.getInstallationToken).toHaveBeenCalledWith(99n);
    expect(typeof octokit.request).toBe('function');
    expect(typeof octokit.hook?.error).toBe('function');
  });
});

describe('build401RetryHandler', () => {
  function makeAuthClient(): AppAuthClient {
    return {
      getInstallationToken: vi
        .fn()
        .mockResolvedValue({ token: 'fresh', expiresAt: new Date(Date.now() + 60_000) }),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('invalidates the cached token, mints a new one, and retries with it on HTTP 401', async () => {
    const authClient = makeAuthClient();
    const request = vi.fn().mockResolvedValue({ data: { login: 'octocat' }, status: 200 });
    const handler = build401RetryHandler({ authClient, installationId: 42n, request });

    const result = await handler({ status: 401 }, { method: 'GET', url: '/user', headers: {} });

    expect(result).toEqual({ data: { login: 'octocat' }, status: 200 });
    expect(authClient.invalidate).toHaveBeenCalledWith(42n);
    expect(authClient.getInstallationToken).toHaveBeenCalledWith(42n);
    // Retry must carry the freshly-minted token, replacing whatever
    // (possibly stale) authorization header was on the failed request.
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/user',
      headers: { authorization: 'token fresh' },
    });
  });

  it('preserves non-authorization headers on retry', async () => {
    const authClient = makeAuthClient();
    const request = vi.fn().mockResolvedValue({ status: 200 });
    const handler = build401RetryHandler({ authClient, installationId: 1n, request });

    await handler(
      { status: 401 },
      { method: 'POST', url: '/x', headers: { 'x-trace-id': 't', authorization: 'token stale' } },
    );

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/x',
      headers: { 'x-trace-id': 't', authorization: 'token fresh' },
    });
  });

  it('rethrows non-401 errors without invalidating or retrying', async () => {
    const authClient = makeAuthClient();
    const request = vi.fn();
    const handler = build401RetryHandler({ authClient, installationId: 7n, request });

    await expect(
      handler({ status: 403, message: 'forbidden' }, { method: 'GET', url: '/' }),
    ).rejects.toEqual({ status: 403, message: 'forbidden' });
    expect(authClient.invalidate).not.toHaveBeenCalled();
    expect(authClient.getInstallationToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rethrows errors with no status property', async () => {
    const authClient = makeAuthClient();
    const handler = build401RetryHandler({
      authClient,
      installationId: 1n,
      request: vi.fn(),
    });
    const err = new Error('network down');
    await expect(handler(err, { method: 'GET', url: '/' })).rejects.toBe(err);
    expect(authClient.invalidate).not.toHaveBeenCalled();
  });
});
