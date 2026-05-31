import type { Outcome } from '../api/types.js';

type StatusBadgeProps = {
  status: Outcome | 'queued' | 'ok' | 'stale' | 'configured' | 'unconfigured';
};

const LABEL_MAP: Record<StatusBadgeProps['status'], string> = {
  approved: '[OK]',
  ok: '[OK]',
  configured: '[OK]',
  changes_requested: '[REVIEW]',
  commented: '[NOTED]',
  failed: '[FAIL]',
  queued: '[QUEUED]',
  stale: '[STALE]',
  unconfigured: '[NONE]',
};

const COLOR_MAP: Record<StatusBadgeProps['status'], string> = {
  approved: 'var(--moss)',
  ok: 'var(--moss)',
  configured: 'var(--moss)',
  changes_requested: 'var(--rust)',
  commented: 'var(--graphite)',
  failed: 'var(--rust)',
  queued: 'var(--graphite)',
  stale: 'var(--graphite)',
  unconfigured: 'var(--graphite)',
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.625rem',
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: COLOR_MAP[status],
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {LABEL_MAP[status]}
    </span>
  );
}
