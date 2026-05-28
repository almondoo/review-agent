import { useEffect, useRef, useState } from 'react';

type MetricCardProps = {
  value: number;
  label: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
};

function useCountUp(target: number, decimals: number, duration = 1200) {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = null;

    function step(ts: number) {
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - (1 - progress) ** 3;
      setCurrent(parseFloat((eased * target).toFixed(decimals)));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, decimals]);

  return current;
}

export function MetricCard({
  value,
  label,
  prefix = '',
  suffix = '',
  decimals = 0,
}: MetricCardProps) {
  const displayed = useCountUp(value, decimals);

  return (
    <div
      style={{
        padding: '1.5rem',
        borderTop: '2px solid var(--ink)',
        position: 'relative',
      }}
    >
      {/* Corner decoration */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: -2,
          right: 0,
          width: 24,
          height: 2,
          backgroundColor: 'var(--rust)',
        }}
      />
      <div className="metric-value">
        {prefix}
        {decimals > 0 ? displayed.toFixed(decimals) : Math.round(displayed)}
        {suffix}
      </div>
      <div className="metric-label" style={{ marginTop: '0.5rem' }}>
        {label}
      </div>
    </div>
  );
}
