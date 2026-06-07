import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../audit-log.js';
import { installationSecrets } from '../byok-store.js';
import { conversationThreads } from '../conversation-state.js';
import { costLedger, installationCostDaily } from '../cost-ledger.js';
import { githubInstallations } from '../github-installations.js';
import { installationMemberships } from '../installation-memberships.js';
import { installationTokens } from '../installation-tokens.js';
import { operatorPrincipals } from '../operator-principals.js';
import { repos } from '../repos.js';
import { reviewEvalEvent } from '../review-eval-event.js';
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
    // Pin the actual TTL — `hasDefault: true` alone would be satisfied even if
    // someone changed the interval to 1 day or removed `now()`. We verify the
    // SQL chunks include both `now()` and `180 days`.
    const sqlText = JSON.stringify(expires?.default);
    expect(sqlText).toContain('now()');
    expect(sqlText).toContain('180 days');
  });

  // §16.1 — every tenant-scoped table must enable RLS and install the
  // tenant_isolation policy keyed on review_agent_app + the
  // app.current_tenant GUC.
  it('repos covers required columns, has nullable installation_id FK, and has no RLS', () => {
    const cfg = getTableConfig(repos);
    expect(cfg.name).toBe('repos');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'id',
      'platform',
      'name',
      'enabled',
      'system_prompt',
      'system_prompt_updated_at',
      'created_at',
      'updated_at',
      'deleted_at',
      'installation_id',
    ]) {
      expect(cols).toContain(required);
    }
    const pk = cfg.columns.find((c) => c.name === 'id');
    expect(pk?.primary).toBe(true);
    // installation_id is nullable (backward compatible)
    const installationIdCol = cfg.columns.find((c) => c.name === 'installation_id');
    expect(installationIdCol?.notNull).toBe(false);
    // repos does not have RLS (no installation_id at row level)
    expect(cfg.enableRLS).toBe(false);
    expect(cfg.policies).toEqual([]);
  });

  it('review_eval_event covers required columns', () => {
    const cfg = getTableConfig(reviewEvalEvent);
    expect(cfg.name).toBe('review_eval_event');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'id',
      'installation_id',
      'job_id',
      'repo',
      'pr_number',
      'head_sha',
      'provider',
      'model',
      'comment_count',
      'severity_dist',
      'confidence_dist',
      'dropped_duplicates',
      'dropped_by_feedback',
      'tool_calls',
      'latency_ms',
      'cost_usd',
      'tokens_input',
      'tokens_output',
      'abort_reason',
      'created_at',
    ]) {
      expect(cols).toContain(required);
    }
  });

  it('github_installations covers required columns with correct types', () => {
    const cfg = getTableConfig(githubInstallations);
    expect(cfg.name).toBe('github_installations');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'installation_id',
      'account_login',
      'account_type',
      'app_id',
      'setup_action',
      'suspended_at',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(required);
    }
    // installation_id is PK
    const pk = cfg.columns.find((c) => c.name === 'installation_id');
    expect(pk?.primary).toBe(true);
    // suspended_at is nullable
    const suspendedAt = cfg.columns.find((c) => c.name === 'suspended_at');
    expect(suspendedAt?.notNull).toBe(false);
    // created_at / updated_at are not null with defaults
    for (const colName of ['created_at', 'updated_at']) {
      const col = cfg.columns.find((c) => c.name === colName);
      expect(col?.notNull).toBe(true);
      expect(col?.hasDefault).toBe(true);
    }
  });

  it('conversation_threads has required columns and unique natural key constraint', () => {
    const cfg = getTableConfig(conversationThreads);
    expect(cfg.name).toBe('conversation_threads');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'id',
      'installation_id',
      'repo',
      'pr_number',
      'root_comment_id',
      'turn_count',
      'last_turn_at',
      'created_at',
    ]) {
      expect(cols).toContain(required);
    }
    // turn_count defaults to 0 and is NOT NULL
    const turnCountCol = cfg.columns.find((c) => c.name === 'turn_count');
    expect(turnCountCol?.notNull).toBe(true);
    expect(turnCountCol?.hasDefault).toBe(true);
    // Unique constraint on natural key
    const uniq = cfg.uniqueConstraints.find((u) => u.name === 'conversation_threads_key_uniq');
    expect(uniq, 'conversation_threads_key_uniq unique constraint must exist').toBeDefined();
    expect(uniq?.columns.map((c) => c.name).sort()).toEqual(
      ['installation_id', 'pr_number', 'repo', 'root_comment_id'].sort(),
    );
  });

  const tenantScoped = [
    ['review_state', reviewState],
    ['review_history', reviewHistory],
    ['cost_ledger', costLedger],
    ['installation_cost_daily', installationCostDaily],
    ['installation_tokens', installationTokens],
    ['audit_log', auditLog],
    ['installation_secrets', installationSecrets],
    ['review_eval_event', reviewEvalEvent],
    ['github_installations', githubInstallations],
    ['conversation_threads', conversationThreads],
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

  it('operator_principals covers required columns with correct types and no RLS', () => {
    const cfg = getTableConfig(operatorPrincipals);
    expect(cfg.name).toBe('operator_principals');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of [
      'id',
      'username',
      'password_hash',
      'provider',
      'external_id',
      'token_version',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(required);
    }
    // id is the primary key
    const pk = cfg.columns.find((c) => c.name === 'id');
    expect(pk?.primary).toBe(true);
    // username is unique (column-level .unique() surfaces as isUnique on the column)
    const usernameCol = cfg.columns.find((c) => c.name === 'username');
    expect(usernameCol?.isUnique, 'username must be unique').toBe(true);
    // password_hash is nullable (OIDC principals have no local password)
    const passwordCol = cfg.columns.find((c) => c.name === 'password_hash');
    expect(passwordCol?.notNull, 'password_hash must be nullable for OIDC users').toBe(false);
    // token_version has default 1
    const tokenVersionCol = cfg.columns.find((c) => c.name === 'token_version');
    expect(tokenVersionCol?.notNull).toBe(true);
    expect(tokenVersionCol?.hasDefault).toBe(true);
    // (provider, external_id) partial index must be UNIQUE — prevents duplicate
    // JIT-provisioned OIDC principals for the same sub (security review #137).
    expect(
      cfg.indexes.some(
        (i) => i.config.name === 'operator_principals_provider_external_id_uidx' && i.config.unique,
      ),
      'provider+external_id index must be UNIQUE',
    ).toBe(true);
    // RLS intentionally omitted (control-plane auth table)
    expect(cfg.enableRLS).toBe(false);
    expect(cfg.policies).toEqual([]);
  });

  it('installation_memberships has composite PK, principal_id index, and no RLS', () => {
    const cfg = getTableConfig(installationMemberships);
    expect(cfg.name).toBe('installation_memberships');
    const cols = cfg.columns.map((c) => c.name);
    for (const required of ['principal_id', 'installation_id', 'role', 'granted_at']) {
      expect(cols).toContain(required);
    }
    // Composite primary key on (principal_id, installation_id)
    expect(cfg.primaryKeys.length).toBe(1);
    expect(cfg.primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(
      ['installation_id', 'principal_id'].sort(),
    );
    // Index on principal_id for lookup by principal
    expect(
      cfg.indexes.some((i) => i.config.name === 'installation_memberships_principal_id_idx'),
    ).toBe(true);
    // role defaults to 'viewer'
    const roleCol = cfg.columns.find((c) => c.name === 'role');
    expect(roleCol?.notNull).toBe(true);
    expect(roleCol?.hasDefault).toBe(true);
    // RLS intentionally omitted (auth middleware table)
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
