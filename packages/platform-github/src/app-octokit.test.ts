import { describe, expect, it, vi } from 'vitest';
import type { AppAuthClient } from './app-auth.js';
import { createAppOctokitFactory } from './app-octokit.js';

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
    // Octokit instances expose .request and .hook:
    expect(typeof octokit.request).toBe('function');
    expect(typeof octokit.hook?.error).toBe('function');
  });
});
