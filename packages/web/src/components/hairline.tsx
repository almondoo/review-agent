type HairlineProps = {
  vertical?: boolean;
  style?: React.CSSProperties;
};

export function Hairline({ vertical = false, style }: HairlineProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        backgroundColor: 'var(--hairline)',
        ...(vertical
          ? { width: '1px', height: '100%', flexShrink: 0 }
          : { height: '1px', width: '100%' }),
        ...style,
      }}
    />
  );
}
