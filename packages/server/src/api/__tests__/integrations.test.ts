import { describe, expect, it } from 'vitest';
import { createIntegrationsRouter } from '../integrations.js';

describe('integrations router', () => {
  function makeApp(
    env: Record<string, string | undefined> = {},
    db?: Parameters<typeof createIntegrationsRouter>[0]['db'],
  ) {
    return createIntegrationsRouter({ env, ...(db !== undefined ? { db } : {}) });
  }

  describe('GET /', () => {
    it('returns all three sections in the response', async () => {
      const app = makeApp();
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('github');
      expect(body).toHaveProperty('codecommit');
      expect(body).toHaveProperty('llm');
    });

    it('github: configured=false when GITHUB_APP_ID absent', async () => {
      const app = makeApp({});
      const body = await (await app.request('http://host/')).json();
      expect(body.github.configured).toBe(false);
      expect(body.github.appId).toBe(null);
    });

    it('github: configured=true and appId masked when GITHUB_APP_ID set', async () => {
      const app = makeApp({ GITHUB_APP_ID: '123456789' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.configured).toBe(true);
      expect(typeof body.github.appId).toBe('string');
      // Must not expose the full key
      expect(body.github.appId).not.toBe('123456789');
      // Must not expose a private key / secret
      expect(String(body.github.appId).includes('****')).toBe(true);
    });

    it('github: installationCount is 0 when no db injected', async () => {
      const app = makeApp({ GITHUB_APP_ID: '111' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.installationCount).toBe(0);
    });

    it('github: appSlug is null when GITHUB_APP_SLUG not set', async () => {
      const app = makeApp({ GITHUB_APP_ID: '111' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.appSlug).toBe(null);
    });

    it('github: appSlug is null when GITHUB_APP_SLUG is empty string', async () => {
      const app = makeApp({ GITHUB_APP_ID: '111', GITHUB_APP_SLUG: '' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.appSlug).toBe(null);
    });

    it('github: appSlug is returned when GITHUB_APP_SLUG is set', async () => {
      const app = makeApp({ GITHUB_APP_ID: '111', GITHUB_APP_SLUG: 'my-review-agent' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.appSlug).toBe('my-review-agent');
    });

    it('github: appSlug present even when GITHUB_APP_ID absent', async () => {
      const app = makeApp({ GITHUB_APP_SLUG: 'standalone-slug' });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.appSlug).toBe('standalone-slug');
      expect(body.github.configured).toBe(false);
    });

    it('github: installationCount from mock DB when db injected', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ value: 7 }]),
          }),
        }),
      } as unknown as Parameters<typeof createIntegrationsRouter>[0]['db'];
      const app = makeApp({ GITHUB_APP_ID: '111' }, mockDb);
      const body = await (await app.request('http://host/')).json();
      expect(body.github.installationCount).toBe(7);
    });

    it('github: installationCount falls back to 0 when db query returns no rows', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as unknown as Parameters<typeof createIntegrationsRouter>[0]['db'];
      const app = makeApp({ GITHUB_APP_ID: '111' }, mockDb);
      const body = await (await app.request('http://host/')).json();
      expect(body.github.installationCount).toBe(0);
    });

    it('github: installationCount defaults to 0 when database throws', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.reject(new Error('connection refused')),
          }),
        }),
      } as unknown as Parameters<typeof createIntegrationsRouter>[0]['db'];
      const app = makeApp({ GITHUB_APP_ID: '111' }, mockDb);
      const body = await (await app.request('http://host/')).json();
      expect(body.github.installationCount).toBe(0);
    });

    it('github: installationCount is 0 when db not injected (no db arg)', async () => {
      const app = createIntegrationsRouter({ env: { GITHUB_APP_ID: '111' } });
      const body = await (await app.request('http://host/')).json();
      expect(body.github.installationCount).toBe(0);
    });

    it('codecommit: configured=false when AWS_REGION absent', async () => {
      const app = makeApp({ REVIEW_AGENT_SNS_TOPIC_ARNS: 'arn:...' });
      const body = await (await app.request('http://host/')).json();
      expect(body.codecommit.configured).toBe(false);
    });

    it('codecommit: configured=false when SNS_TOPIC_ARNS absent', async () => {
      const app = makeApp({ AWS_REGION: 'us-east-1' });
      const body = await (await app.request('http://host/')).json();
      expect(body.codecommit.configured).toBe(false);
    });

    it('codecommit: configured=true when both region and topics set', async () => {
      const app = makeApp({
        AWS_REGION: 'us-east-1',
        REVIEW_AGENT_SNS_TOPIC_ARNS: 'arn:a,arn:b',
      });
      const body = await (await app.request('http://host/')).json();
      expect(body.codecommit.configured).toBe(true);
      expect(body.codecommit.region).toBe('us-east-1');
    });

    it('codecommit: region is null when AWS_REGION not set', async () => {
      const app = makeApp({});
      const body = await (await app.request('http://host/')).json();
      expect(body.codecommit.region).toBe(null);
    });

    it('codecommit: does not expose topic ARN values', async () => {
      const arn = 'arn:aws:sns:us-east-1:111:my-secret-topic';
      const app = makeApp({
        AWS_REGION: 'us-east-1',
        REVIEW_AGENT_SNS_TOPIC_ARNS: arn,
      });
      const body = await (await app.request('http://host/')).json();
      expect(JSON.stringify(body)).not.toContain(arn);
    });

    it('llm: configured=false when no key present', async () => {
      const app = makeApp({});
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.configured).toBe(false);
      expect(body.llm.provider).toBe(null);
    });

    it('llm: configured=true and provider=anthropic when ANTHROPIC_API_KEY set', async () => {
      const app = makeApp({ ANTHROPIC_API_KEY: 'sk-ant-...' });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.configured).toBe(true);
      expect(body.llm.provider).toBe('anthropic');
    });

    it('llm: configured=true and provider=openai when only OPENAI_API_KEY set', async () => {
      const app = makeApp({ OPENAI_API_KEY: 'sk-...' });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.configured).toBe(true);
      expect(body.llm.provider).toBe('openai');
    });

    it('llm: explicit REVIEW_AGENT_PROVIDER overrides key inference', async () => {
      const app = makeApp({
        ANTHROPIC_API_KEY: 'sk-ant-...',
        REVIEW_AGENT_PROVIDER: 'azure-openai',
      });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.provider).toBe('azure-openai');
    });

    it('llm: does not expose API key values', async () => {
      const key = 'sk-ant-super-secret-key';
      const app = makeApp({ ANTHROPIC_API_KEY: key });
      const body = await (await app.request('http://host/')).json();
      expect(JSON.stringify(body)).not.toContain(key);
    });

    it('llm: model defaults to claude-sonnet-4-5 for anthropic driver', async () => {
      const app = makeApp({ ANTHROPIC_API_KEY: 'sk-ant-...' });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe('claude-sonnet-4-5');
    });

    it('llm: model uses REVIEW_AGENT_MODEL when set', async () => {
      const app = makeApp({
        ANTHROPIC_API_KEY: 'sk-ant-...',
        REVIEW_AGENT_MODEL: 'claude-opus-4',
      });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe('claude-opus-4');
    });

    it('llm: model uses ANTHROPIC_MODEL when set for anthropic driver', async () => {
      const app = makeApp({
        ANTHROPIC_API_KEY: 'sk-ant-...',
        ANTHROPIC_MODEL: 'claude-haiku-3',
      });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe('claude-haiku-3');
    });

    it('llm: REVIEW_AGENT_MODEL takes precedence over ANTHROPIC_MODEL', async () => {
      const app = makeApp({
        ANTHROPIC_API_KEY: 'sk-ant-...',
        REVIEW_AGENT_MODEL: 'claude-opus-4',
        ANTHROPIC_MODEL: 'claude-haiku-3',
      });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe('claude-opus-4');
    });

    it('llm: model is null when provider is not anthropic and REVIEW_AGENT_MODEL not set', async () => {
      const app = makeApp({ OPENAI_API_KEY: 'sk-...' });
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe(null);
    });

    it('llm: model is null when no provider configured', async () => {
      const app = makeApp({});
      const body = await (await app.request('http://host/')).json();
      expect(body.llm.model).toBe(null);
    });
  });
});
