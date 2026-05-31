import type { Platform } from '../api/types.js';

type PlatformBadgeProps = {
  platform: Platform;
};

export function PlatformBadge({ platform }: PlatformBadgeProps) {
  const label = platform === 'github' ? '[GH]' : '[CC]';
  const color = platform === 'github' ? 'var(--ink)' : 'var(--graphite)';
  return (
    <span className="label-mono" style={{ color }}>
      {label}
    </span>
  );
}
