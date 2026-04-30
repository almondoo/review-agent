import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import type { AppAuthClient } from './app-auth.js';

const ThrottledOctokit = Octokit.plugin(retry, throttling);

export type AppOctokitOptions = {
  readonly authClient: AppAuthClient;
  readonly userAgent?: string;
};

export type AppOctokitFactory = (installationId: bigint) => Promise<Octokit>;

export function createAppOctokitFactory(opts: AppOctokitOptions): AppOctokitFactory {
  return async (installationId: bigint) => {
    const fetchToken = async () => {
      const t = await opts.authClient.getInstallationToken(installationId);
      return t.token;
    };
    const initialToken = await fetchToken();

    let currentToken = initialToken;
    const octokit = new ThrottledOctokit({
      auth: currentToken,
      userAgent: opts.userAgent ?? 'review-agent',
      throttle: {
        onRateLimit: (_retryAfter, _options, _ok, retryCount) => retryCount < 2,
        onSecondaryRateLimit: (retryAfter) => retryAfter < 60,
      },
      retry: { doNotRetry: ['400', '401', '403', '404', '422'] },
    });

    octokit.hook.error('request', async (error, options) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error as { status?: number }).status === 401
      ) {
        await opts.authClient.invalidate(installationId);
        currentToken = await fetchToken();
        return octokit.request({
          ...options,
          headers: { ...options.headers, authorization: `token ${currentToken}` },
        });
      }
      throw error;
    });

    return octokit;
  };
}
