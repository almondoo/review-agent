// Decorative SVG noise overlay — pointer-events: none, covers viewport
export function GrainOverlay() {
  const svgNoise =
    "data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E";

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `url("${svgNoise}")`,
        backgroundRepeat: 'repeat',
        backgroundSize: '256px 256px',
        opacity: 0.025,
        pointerEvents: 'none',
        zIndex: 9999,
        mixBlendMode: 'multiply',
      }}
    />
  );
}
