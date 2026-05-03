import { describe, expect, it, vi } from 'vitest';
import { setupWorkspaceCommand } from './setup-workspace.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('setupWorkspaceCommand — manual mode (default)', () => {
  it('prints the manual checklist with the configured workspace name', async () => {
    const io = recordingIo();
    const result = await setupWorkspaceCommand(io, {
      env: {} as NodeJS.ProcessEnv,
      name: 'acme-review',
      spendCapUsd: 25,
    });
    expect(result.status).toBe('manual');
    const body = io.out.join('');
    expect(body).toContain('manual checklist');
    expect(body).toContain('Name: acme-review');
    expect(body).toContain('USD 25');
    // Defaults are surfaced so the operator can copy them as-is.
    expect(body).toContain('claude-sonnet-4-6');
    expect(body).toContain('ANTHROPIC_API_KEY');
    expect(io.err.join('')).toBe('');
  });

  it('uses default name and spend cap when none provided', async () => {
    const io = recordingIo();
    const result = await setupWorkspaceCommand(io, { env: {} as NodeJS.ProcessEnv });
    expect(result.status).toBe('manual');
    const body = io.out.join('');
    expect(body).toContain('Name: review-agent');
    expect(body).toContain('USD 50');
  });
});

describe('setupWorkspaceCommand — --api mode', () => {
  it('reports auth_failed when ANTHROPIC_ADMIN_KEY is missing', async () => {
    const io = recordingIo();
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('ANTHROPIC_ADMIN_KEY');
  });

  it('creates workspace and sets spend cap when both endpoints succeed', async () => {
    const io = recordingIo();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'ws_123' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      name: 'rev',
      spendCapUsd: 10,
      fetchFn,
    });
    expect(result).toEqual({ status: 'api_ok', workspaceId: 'ws_123' });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchFn.mock.calls[0] ?? [];
    expect(createUrl).toBe('https://api.anthropic.com/v1/organizations/workspaces');
    expect(createInit?.method).toBe('POST');
    expect((createInit?.headers as Record<string, string>)['x-api-key']).toBe('sk-admin-test');
    expect(JSON.parse(String(createInit?.body))).toEqual({ name: 'rev' });

    const [capUrl, capInit] = fetchFn.mock.calls[1] ?? [];
    expect(capUrl).toBe('https://api.anthropic.com/v1/organizations/workspaces/ws_123/spend_limit');
    expect(JSON.parse(String(capInit?.body))).toEqual({ limit_usd_per_month: 10 });

    const out = io.out.join('');
    expect(out).toContain("Created workspace 'rev'");
    expect(out).toContain('USD 10');
    expect(out).toContain('Workspace id: ws_123');
  });

  it('reports api_failed when the workspace create call returns non-2xx', async () => {
    const io = recordingIo();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403, statusText: 'Forbidden' }));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.status).toBe('api_failed');
    expect(result.workspaceId).toBeUndefined();
    expect(io.err.join('')).toContain('403');
    // Spend-cap call must not run if workspace create failed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports api_failed when the spend-cap call fails after a successful workspace create', async () => {
    const io = recordingIo();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'ws_456' }))
      .mockResolvedValueOnce(new Response('limit', { status: 422, statusText: 'Unprocessable' }));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.status).toBe('api_failed');
    // Workspace id is still returned so the operator can clean up manually.
    expect(result.workspaceId).toBe('ws_456');
    expect(io.err.join('')).toContain('422');
  });

  it('reports api_failed when the workspace create response has no id', async () => {
    const io = recordingIo();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.status).toBe('api_failed');
    expect(io.err.join('')).toContain('no id');
  });

  it('reports api_failed and the underlying message when the workspace create throws', async () => {
    const io = recordingIo();
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network down'));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.status).toBe('api_failed');
    expect(result.errorMessage).toBe('network down');
  });

  it('reports api_failed when the spend-cap fetch itself throws after a successful create', async () => {
    const io = recordingIo();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'ws_throw' }))
      .mockRejectedValueOnce(new Error('cap network blip'));
    const result = await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: 'sk-admin-test' } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.status).toBe('api_failed');
    expect(result.workspaceId).toBe('ws_throw');
    expect(result.errorMessage).toBe('cap network blip');
    expect(io.err.join('')).toContain('cap network blip');
  });

  it('does not log the admin key in stdout or stderr (success path)', async () => {
    const io = recordingIo();
    const adminKey = 'sk-admin-secret-VERY-SENSITIVE';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'ws_x' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: adminKey } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(io.out.join('')).not.toContain(adminKey);
    expect(io.err.join('')).not.toContain(adminKey);
  });

  it('does not log the admin key in stdout or stderr (error path)', async () => {
    // Regression guard: a future change that dumps the request init
    // (which contains the `x-api-key` header) into stderr on error
    // would slip past the success-path assertion above. This case
    // exercises the non-2xx branch explicitly.
    const io = recordingIo();
    const adminKey = 'sk-admin-secret-VERY-SENSITIVE-error';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Server' }));
    await setupWorkspaceCommand(io, {
      api: true,
      env: { ANTHROPIC_ADMIN_KEY: adminKey } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(io.out.join('')).not.toContain(adminKey);
    expect(io.err.join('')).not.toContain(adminKey);
  });
});
