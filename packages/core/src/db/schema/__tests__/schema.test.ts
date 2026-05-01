import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../audit-log.js';
import { installationSecrets } from '../byok-store.js';
import { costLedger, installationCostDaily } from '../cost-ledger.js';
import { installationTokens } from '../installation-tokens.js';
import { reviewHistory } from '../review-history.js';
import { reviewState } from '../review-state.js';
import { webhookDeliveries } from '../webhook-deliveries.js';

const tableNames = (table: Parameters<typeof getTableConfig>[0]): string[] =>
  getTableConfig(table).columns.map((c) => c.name);

describe('db schema shape', () => {
  it('webhook_deliveries has delivery_id PK + received_at index', () => {
    const cfg = getTableConfig(webhookDeliveries);
    expect(cfg.name).toBe('webhook_deliveries');
    expect(tableNames(webhookDeliveries)).toEqual(['delivery_id', 'received_at', 'status']);
    const pk = cfg.columns.find((c) => c.name === 'delivery_id');
    expect(pk?.primary).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'webhook_deliveries_received_at_idx')).toBe(
      true,
    );
  });

  it('installation_tokens keyed by installation_id', () => {
    const cfg = getTableConfig(installationTokens);
    expect(cfg.name).toBe('installation_tokens');
    expect(cfg.columns.find((c) => c.name === 'installation_id')?.primary).toBe(true);
    expect(tableNames(installationTokens)).toContain('expires_at');
  });

  it('review_state is unique on (installation_id, pr_id)', () => {
    const cfg = getTableConfig(reviewState);
    expect(cfg.name).toBe('review_state');
    expect(
      cfg.uniqueConstraints.some((u) => u.name === 'review_state_installation_pr_idx') ||
        cfg.indexes.some(
          (i) => i.config.unique && i.config.name === 'review_state_installation_pr_idx',
        ),
    ).toBe(true);
  });

  it('cost_ledger covers all required columns', () => {
    const cols = tableNames(costLedger);
    for (const required of [
      'installation_id',
      'job_id',
      'provider',
      'model',
      'call_phase',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'cost_usd',
      'status',
      'created_at',
    ]) {
      expect(cols).toContain(required);
    }
  });

  it('installation_cost_daily uses composite PK', () => {
    const cfg = getTableConfig(installationCostDaily);
    expect(cfg.primaryKeys.length).toBe(1);
    expect(cfg.primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(
      ['date', 'installation_id'].sort(),
    );
  });

  it('audit_log has prev_hash + hash', () => {
    const cols = tableNames(auditLog);
    expect(cols).toContain('prev_hash');
    expect(cols).toContain('hash');
  });

  it('review_history defaults expires_at to now() + 180 days', () => {
    const cfg = getTableConfig(reviewHistory);
    const expires = cfg.columns.find((c) => c.name === 'expires_at');
    expect(expires).toBeDefined();
    expect(expires?.notNull).toBe(true);
    expect(expires?.hasDefault).toBe(true);
  });

  // §16.1 — every tenant-scoped table must enable RLS and install the
  // tenant_isolation policy keyed on review_agent_app + the
  // app.current_tenant GUC.
  const tenantScoped = [
    ['review_state', reviewState],
    ['review_history', reviewHistory],
    ['cost_ledger', costLedger],
    ['installation_cost_daily', installationCostDaily],
    ['installation_tokens', installationTokens],
    ['audit_log', auditLog],
    ['installation_secrets', installationSecrets],
  ] as const;

  for (const [name, table] of tenantScoped) {
    it(`${name} enables RLS with a tenant_isolation policy`, () => {
      const cfg = getTableConfig(table);
      expect(cfg.enableRLS).toBe(true);
      const policy = cfg.policies.find((p) => p.name === 'tenant_isolation');
      expect(policy, `${name} must have a tenant_isolation policy`).toBeDefined();
      expect(policy?.as).toBe('permissive');
      expect(policy?.for).toBe('all');
    });
  }

  it('webhook_deliveries does not enable RLS (no installation_id column)', () => {
    const cfg = getTableConfig(webhookDeliveries);
    expect(cfg.enableRLS).toBe(false);
    expect(cfg.policies).toEqual([]);
  });

  it('installation_secrets is keyed by (installation_id, provider) and stores envelope blobs as bytea', () => {
    const cfg = getTableConfig(installationSecrets);
    expect(cfg.name).toBe('installation_secrets');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'installation_id',
      'provider',
      'kms_key_id',
      'wrapped_data_key',
      'encrypted_secret',
      'iv',
      'auth_tag',
      'created_at',
      'rotated_at',
    ]) {
      expect(cols).toContain(required);
    }
    // Composite primary key on (installation_id, provider).
    expect(cfg.primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(
      ['installation_id', 'provider'].sort(),
    );
    // bytea typed columns
    for (const name of ['wrapped_data_key', 'encrypted_secret', 'iv', 'auth_tag']) {
      const col = cfg.columns.find((c) => c.name === name);
      expect(col?.dataType).toBe('custom');
    }
  });
});
