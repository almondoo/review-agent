import { createHash } from 'node:crypto';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export type AuditEvent = {
  readonly ts?: Date;
  readonly installationId?: bigint | null;
  readonly prId?: string | null;
  readonly event: string;
  readonly model?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
};

export type AuditRow = AuditEvent & {
  readonly ts: Date;
  readonly prevHash: string;
  readonly hash: string;
};

export function canonicalPayload(ev: AuditEvent, ts: Date): string {
  const ordered = {
    ts: ts.toISOString(),
    installationId: ev.installationId != null ? String(ev.installationId) : null,
    prId: ev.prId ?? null,
    event: ev.event,
    model: ev.model ?? null,
    inputTokens: ev.inputTokens ?? null,
    outputTokens: ev.outputTokens ?? null,
  };
  return JSON.stringify(ordered);
}

export function computeAuditHash(prevHash: string, ev: AuditEvent, ts: Date): string {
  const payload = canonicalPayload(ev, ts);
  return createHash('sha256').update(prevHash).update(payload).digest('hex');
}

export type ChainLink = {
  readonly prevHash: string | null;
  readonly hash: string;
  readonly ts: Date;
  readonly event: string;
  readonly installationId: bigint | null;
  readonly prId: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export type ChainBreak = {
  readonly index: number;
  readonly expected: string;
  readonly actual: string;
  readonly row: ChainLink;
};

export function verifyAuditChain(rows: ReadonlyArray<ChainLink>): {
  readonly ok: boolean;
  readonly breaks: ReadonlyArray<ChainBreak>;
} {
  const breaks: ChainBreak[] = [];
  let prev = AUDIT_GENESIS_HASH;
  rows.forEach((row, index) => {
    const expected = computeAuditHash(prev, row, row.ts);
    if (row.hash !== expected) {
      breaks.push({ index, expected, actual: row.hash, row });
    }
    prev = row.hash;
  });
  return { ok: breaks.length === 0, breaks };
}

export function appendAuditRow(prevHash: string | null, ev: AuditEvent, now: () => Date): AuditRow {
  const ts = ev.ts ?? now();
  const usePrev = prevHash ?? AUDIT_GENESIS_HASH;
  const hash = computeAuditHash(usePrev, ev, ts);
  return {
    ...ev,
    ts,
    prevHash: usePrev,
    hash,
  };
}
