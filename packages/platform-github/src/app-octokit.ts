import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import type { EndpointDefaults } from '@octokit/types';
import type { AppAuthClient } from './app-auth.js';

const ThrottledOctokit = Octokit.plugin(retry, throttling);

export type AppOctokitOptions = {
  readonly authClient: AppAuthClient;
  readonly userAgent?: string;
};

export type AppOctokitFactory = (installationId: bigint) => Promise<Octokit>;

// The shape Octokit's `hook.error('request', ...)` and `octokit.request(...)`
// agree on. We pull the canonical type from @octokit/types so the hook wiring
// below type-checks without casts.
export type OctokitRequestOptions = Required<EndpointDefaults>;

// Extracted so callers can unit-test the 401-retry contract without spinning
// up a live Octokit instance + global fetch mock. The wired hook in
// `createAppOctokitFactory` is a thin adapter that closes over the
// installation id and the host octokit's `request` method.
//
// Generic over the options shape: production uses Octokit's
// `Required<EndpointDefaults>`, while tests pass a minimal subset matching
// only the `headers` field the handler actually reads.
export function build401RetryHandler<
  TOptions extends { headers?: Record<string, string | number | undefined> },
>(args: {
  readonly authClient: AppAuthClient;
  readonly installationId: bigint;
  readonly request: (options: TOptions) => Promise<unknown>;
}): (error: Error, options: TOptions) => Promise<unknown> {
  return async (error, options) => {
    if ((error as { status?: number }).status === 401) {
      await args.authClient.invalidate(args.installationId);
      const fresh = await args.authClient.getInstallationToken(args.installationId);
      return args.request({
        ...options,
        headers: { ...options.headers, authorization: `token ${fresh.token}` },
      });
    }
    throw error;
  };
}

export function createAppOctokitFactory(opts: AppOctokitOptions): AppOctokitFactory {
  return async (installationId: bigint) => {
    const initial = await opts.authClient.getInstallationToken(installationId);

    const octokit = new ThrottledOctokit({
      auth: initial.token,
      userAgent: opts.userAgent ?? 'review-agent',
      throttle: {
        onRateLimit: (_retryAfter, _options, _ok, retryCount) => retryCount < 2,
        onSecondaryRateLimit: (retryAfter) => retryAfter < 60,
      },
      retry: { doNotRetry: ['400', '401', '403', '404', '422'] },
    });

    octokit.hook.error(
      'request',
      build401RetryHandler<OctokitRequestOptions>({
        authClient: opts.authClient,
        installationId,
        request: (options) => octokit.request(options),
      }),
    );

    return octokit;
  };
}
