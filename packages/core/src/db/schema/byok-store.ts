import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
});

// Per-installation BYOK provider secret (spec §8.5).
//
// `encrypted_secret` is the customer's API key encrypted with a fresh
// AES-256-GCM data key; that data key is itself wrapped under
// `kms_key_id` (a CMK ARN / resource name) and stored in
// `wrapped_data_key`. The plaintext data key is discarded after use.
//
// Tenant scoping is enforced by the same `tenant_isolation` policy
// applied to every other tenant table (§16.1). A leak through this
// row requires both an RLS bypass *and* compromise of the KMS CMK.
export const installationSecrets = pgTable(
  'installation_secrets',
  {
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    provider: text('provider').notNull(),
    kmsKeyId: text('kms_key_id').notNull(),
    wrappedDataKey: bytea('wrapped_data_key').notNull(),
    encryptedSecret: bytea('encrypted_secret').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.provider] }),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type InstallationSecretRow = typeof installationSecrets.$inferSelect;
export type NewInstallationSecret = typeof installationSecrets.$inferInsert;
