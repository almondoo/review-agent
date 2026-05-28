import { Hairline } from './hairline.js';

type SectionHeadingProps = {
  title: string;
  subtitle?: string;
};

export function SectionHeading({ title, subtitle }: SectionHeadingProps) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 className="section-title" style={{ marginBottom: '0.5rem' }}>
        {title}
      </h2>
      {subtitle && (
        <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '1rem' }}>
          {subtitle}
        </p>
      )}
      <Hairline />
    </div>
  );
}
