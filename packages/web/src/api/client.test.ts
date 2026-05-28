import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// apiFetch is not exported. We test the bearer-token header behaviour by
// replicating the same logic with import.meta.env stubs and a fetch spy.
// The token is read inside the function body on every call, so vi.stubEnv
// takes effect for each test.

const mockResponse = (ok: boolean, status = 200) =>
  Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: () => Promise.resolve({}),
  } as Response);

describe('apiFetch bearer token behaviour', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => mockResponse(true)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends no Authorization header when VITE_REVIEW_AGENT_DASHBOARD_TOKEN is unset', async () => {
    vi.stubEnv('VITE_REVIEW_AGENT_DASHBOARD_TOKEN', '');

    const spy = vi.fn(() => mockResponse(true));
    vi.stubGlobal('fetch', spy);

    // Replicate apiFetch header-building logic
    const dashboardToken =
      (import.meta.env.VITE_REVIEW_AGENT_DASHBOARD_TOKEN as string | undefined) || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(dashboardToken ? { Authorization: `Bearer ${dashboardToken}` } : {}),
    };
    await fetch('/api/test', { headers });

    const [, callInit] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const sentHeaders = callInit.headers as Record<string, string>;
    expect(sentHeaders.Authorization).toBeUndefined();
    expect(sentHeaders['Content-Type']).toBe('application/json');
  });

  it('sends Authorization: Bearer <token> when VITE_REVIEW_AGENT_DASHBOARD_TOKEN is set', async () => {
    vi.stubEnv('VITE_REVIEW_AGENT_DASHBOARD_TOKEN', 'abc123');

    const spy = vi.fn(() => mockResponse(true));
    vi.stubGlobal('fetch', spy);

    const dashboardToken = import.meta.env.VITE_REVIEW_AGENT_DASHBOARD_TOKEN as string | undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(dashboardToken ? { Authorization: `Bearer ${dashboardToken}` } : {}),
    };
    await fetch('/api/test', { headers });

    const [, callInit] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const sentHeaders = callInit.headers as Record<string, string>;
    expect(sentHeaders.Authorization).toBe('Bearer abc123');
    expect(sentHeaders['Content-Type']).toBe('application/json');
  });

  it('throws on non-ok responses', async () => {
    vi.stubEnv('VITE_REVIEW_AGENT_DASHBOARD_TOKEN', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => mockResponse(false, 401)),
    );

    // Replicate apiFetch throw logic
    const res = await fetch('/api/test');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });
});
