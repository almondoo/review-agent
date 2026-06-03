import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';

// ─── Pipeline diagram ──────────────────────────────────────────────────────────

type PipelineStep = {
  number: number;
  titleKey: string;
  descKey: string;
};

const PIPELINE_STEPS: PipelineStep[] = [
  { number: 1, titleKey: 'pages.howItWorks.step1Title', descKey: 'pages.howItWorks.step1Desc' },
  { number: 2, titleKey: 'pages.howItWorks.step2Title', descKey: 'pages.howItWorks.step2Desc' },
  { number: 3, titleKey: 'pages.howItWorks.step3Title', descKey: 'pages.howItWorks.step3Desc' },
  { number: 4, titleKey: 'pages.howItWorks.step4Title', descKey: 'pages.howItWorks.step4Desc' },
  { number: 5, titleKey: 'pages.howItWorks.step5Title', descKey: 'pages.howItWorks.step5Desc' },
  { number: 6, titleKey: 'pages.howItWorks.step6Title', descKey: 'pages.howItWorks.step6Desc' },
  { number: 7, titleKey: 'pages.howItWorks.step7Title', descKey: 'pages.howItWorks.step7Desc' },
];

function PipelineDiagram() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="label-mono"
        style={{
          color: 'var(--graphite)',
          marginBottom: '1.5rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        {t('pages.howItWorks.pipelineLabel')}
      </h3>

      {/* Grid — collapses to single column on narrow screens */}
      <div
        role="img"
        aria-label={t('pages.howItWorks.pipelineAriaLabel')}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '1px',
          backgroundColor: 'var(--hairline)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
        }}
      >
        {PIPELINE_STEPS.map((step) => (
          <div
            key={step.number}
            style={{
              backgroundColor: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              padding: '1.25rem 1rem',
            }}
          >
            {/* Step number badge + connector arrow */}
            <div
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '1.75rem',
                  height: '1.75rem',
                  borderRadius: '50%',
                  border: '1.5px solid var(--rust)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  color: 'var(--rust)',
                  flexShrink: 0,
                }}
              >
                {step.number}
              </span>
              {step.number < PIPELINE_STEPS.length && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  style={{ opacity: 0.3, marginLeft: 'auto' }}
                >
                  <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5" />
                  <polyline
                    points="9,3 14,8 9,13"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </div>

            {/* Step title */}
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(0.875rem, 1.5vw, 1rem)',
                fontWeight: 700,
                color: 'var(--ink)',
                margin: 0,
                lineHeight: 1.25,
              }}
            >
              {t(step.titleKey)}
            </h3>

            {/* Step description */}
            <p
              className="body-sm"
              style={{
                color: 'var(--graphite)',
                margin: 0,
                lineHeight: 1.6,
                fontSize: '0.75rem',
              }}
            >
              {t(step.descKey)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Safety pillars ─────────────────────────────────────────────────────────────

type SafetyPillar = {
  titleKey: string;
  descKey: string;
  icon: 'lock' | 'scan' | 'boundary' | 'shield' | 'cost';
};

const SAFETY_PILLARS: SafetyPillar[] = [
  {
    titleKey: 'pages.howItWorks.safetyReadOnlyTitle',
    descKey: 'pages.howItWorks.safetyReadOnlyDesc',
    icon: 'lock',
  },
  {
    titleKey: 'pages.howItWorks.safetyScanTitle',
    descKey: 'pages.howItWorks.safetyScanDesc',
    icon: 'scan',
  },
  {
    titleKey: 'pages.howItWorks.safetyBoundaryTitle',
    descKey: 'pages.howItWorks.safetyBoundaryDesc',
    icon: 'boundary',
  },
  {
    titleKey: 'pages.howItWorks.safetyInjectionTitle',
    descKey: 'pages.howItWorks.safetyInjectionDesc',
    icon: 'shield',
  },
  {
    titleKey: 'pages.howItWorks.safetyCostTitle',
    descKey: 'pages.howItWorks.safetyCostDesc',
    icon: 'cost',
  },
];

function SafetyIcon({ kind }: { kind: SafetyPillar['icon'] }) {
  const size = 24;
  const stroke = 'currentColor';
  const sw = 1.5;
  if (kind === 'lock') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="1" stroke={stroke} strokeWidth={sw} />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'scan') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <line x1="3" y1="12" x2="21" y2="12" stroke={stroke} strokeWidth={sw} />
        <path
          d="M5 4h2v2M17 4h2v2M5 20h2v-2M17 20h2v-2"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'boundary') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="8" height="8" rx="1" stroke={stroke} strokeWidth={sw} />
        <rect x="13" y="13" width="8" height="8" rx="1" stroke={stroke} strokeWidth={sw} />
        <line
          x1="11"
          y1="7"
          x2="13"
          y2="7"
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray="2 2"
        />
        <line
          x1="17"
          y1="11"
          x2="17"
          y2="13"
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }
  if (kind === 'shield') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3L4 7v5c0 5 4 8 8 9 4-1 8-4 8-9V7L12 3z"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <polyline
          points="9,12 11,14 15,10"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // cost
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeWidth={sw} />
      <line x1="12" y1="6" x2="12" y2="18" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      <path
        d="M9 9h4.5a1.5 1.5 0 0 1 0 3H10.5a1.5 1.5 0 0 0 0 3H15"
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap="round"
      />
    </svg>
  );
}

function SafetySection() {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading
        title={t('pages.howItWorks.safetyTitle')}
        subtitle={t('pages.howItWorks.safetySubtitle')}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1px',
          backgroundColor: 'var(--hairline)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
        }}
      >
        {SAFETY_PILLARS.map((pillar) => (
          <div
            key={pillar.titleKey}
            style={{
              backgroundColor: 'var(--bg)',
              padding: '1.25rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <span style={{ color: 'var(--graphite)', display: 'block', width: 24, height: 24 }}>
              <SafetyIcon kind={pillar.icon} />
            </span>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '0.9375rem',
                fontWeight: 700,
                color: 'var(--ink)',
                margin: 0,
                lineHeight: 1.3,
              }}
            >
              {t(pillar.titleKey)}
            </h3>
            <p
              className="body-sm"
              style={{
                color: 'var(--graphite)',
                margin: 0,
                lineHeight: 1.6,
                fontSize: '0.8125rem',
              }}
            >
              {t(pillar.descKey)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Provider chips ──────────────────────────────────────────────────────────

const PROVIDERS = [
  'Anthropic',
  'OpenAI',
  'Azure OpenAI',
  'Google',
  'Vertex AI',
  'AWS Bedrock',
  'OpenAI互換',
] as const;

const DEFAULT_PROVIDER = 'Anthropic';

function ProvidersSection() {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading
        title={t('pages.howItWorks.providersTitle')}
        subtitle={t('pages.howItWorks.providersSubtitle')}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
        }}
      >
        {PROVIDERS.map((name) => (
          <span
            key={name}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              padding: '0.375rem 0.75rem',
              border: `1px solid ${name === DEFAULT_PROVIDER ? 'var(--rust)' : 'var(--hairline)'}`,
              borderRadius: 'var(--radius)',
              color: name === DEFAULT_PROVIDER ? 'var(--rust)' : 'var(--graphite)',
              backgroundColor: name === DEFAULT_PROVIDER ? 'transparent' : 'var(--bg-raised)',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
            {name === DEFAULT_PROVIDER && (
              <span
                style={{
                  marginLeft: '0.375rem',
                  fontSize: '0.5625rem',
                  opacity: 0.7,
                  textTransform: 'uppercase',
                }}
              >
                {t('pages.howItWorks.defaultBadge')}
              </span>
            )}
          </span>
        ))}
      </div>
    </section>
  );
}

// ─── Entry points mini-diagram ────────────────────────────────────────────────

type EntryPoint = {
  nameKey: string;
  descKey: string;
};

const ENTRY_POINTS: EntryPoint[] = [
  {
    nameKey: 'pages.howItWorks.entryAction',
    descKey: 'pages.howItWorks.entryActionDesc',
  },
  {
    nameKey: 'pages.howItWorks.entryWebhook',
    descKey: 'pages.howItWorks.entryWebhookDesc',
  },
  {
    nameKey: 'pages.howItWorks.entryCli',
    descKey: 'pages.howItWorks.entryCliDesc',
  },
];

function EntryPointsDiagram() {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t('pages.howItWorks.entryAriaLabel')}
      role="img"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1rem',
        alignItems: 'stretch',
        marginTop: '1rem',
      }}
    >
      {ENTRY_POINTS.map((ep, i) => (
        <div
          key={ep.nameKey}
          style={{
            flex: '1 1 160px',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            padding: '1rem',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-raised)',
            position: 'relative',
          }}
        >
          <span
            className="label-mono"
            style={{
              color: 'var(--rust)',
              fontSize: '0.5625rem',
              letterSpacing: '0.12em',
            }}
          >
            {String(i + 1).padStart(2, '0')}
          </span>
          <strong
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              fontWeight: 700,
              color: 'var(--ink)',
              letterSpacing: '0.04em',
            }}
          >
            {t(ep.nameKey)}
          </strong>
          <p
            className="body-sm"
            style={{ color: 'var(--graphite)', margin: 0, fontSize: '0.75rem', lineHeight: 1.6 }}
          >
            {t(ep.descKey)}
          </p>
        </div>
      ))}

      {/* Merge arrow to pipeline */}
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          padding: '0 0.5rem',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <line
            x1="4"
            y1="16"
            x2="28"
            y2="16"
            stroke="var(--graphite)"
            strokeWidth="1.5"
            opacity="0.4"
          />
          <polyline
            points="22,10 28,16 22,22"
            stroke="var(--graphite)"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.4"
          />
        </svg>
      </div>

      {/* Pipeline box */}
      <div
        style={{
          flex: '1 1 160px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '0.5rem',
          padding: '1rem',
          border: '1px solid var(--rust)',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg)',
        }}
      >
        <span
          className="label-mono"
          style={{ color: 'var(--rust)', fontSize: '0.5625rem', letterSpacing: '0.12em' }}
        >
          {t('pages.howItWorks.entryPipelineLabel')}
        </span>
        <strong
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '0.9375rem',
            fontWeight: 700,
            color: 'var(--ink)',
          }}
        >
          {t('pages.howItWorks.entryPipelineTitle')}
        </strong>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function HowItWorksPage() {
  const { t } = useTranslation();
  const entryHeadingId = useId();

  return (
    <StaggerContainer>
      {/* Header */}
      <StaggerItem>
        <SectionHeading
          title={t('pages.howItWorks.title')}
          subtitle={t('pages.howItWorks.subtitle')}
        />
      </StaggerItem>

      {/* Intro text */}
      <StaggerItem>
        <p
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 'clamp(1rem, 2vw, 1.125rem)',
            color: 'var(--graphite)',
            lineHeight: 1.7,
            maxWidth: '64ch',
            marginBottom: '3rem',
          }}
        >
          {t('pages.howItWorks.intro')}
        </p>
      </StaggerItem>

      {/* Entry points */}
      <StaggerItem>
        <section aria-labelledby={entryHeadingId} style={{ marginBottom: '3rem' }}>
          <h3
            id={entryHeadingId}
            className="label-mono"
            style={{
              color: 'var(--graphite)',
              marginBottom: '1rem',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            {t('pages.howItWorks.entryPointsLabel')}
          </h3>
          <EntryPointsDiagram />
        </section>
      </StaggerItem>

      <StaggerItem>
        <Hairline style={{ marginBottom: '3rem' }} />
      </StaggerItem>

      {/* Pipeline */}
      <StaggerItem>
        <div style={{ marginBottom: '3rem' }}>
          <PipelineDiagram />
        </div>
      </StaggerItem>

      <StaggerItem>
        <Hairline style={{ marginBottom: '3rem' }} />
      </StaggerItem>

      {/* Safety */}
      <StaggerItem>
        <div style={{ marginBottom: '3rem' }}>
          <SafetySection />
        </div>
      </StaggerItem>

      <StaggerItem>
        <Hairline style={{ marginBottom: '3rem' }} />
      </StaggerItem>

      {/* Providers */}
      <StaggerItem>
        <div style={{ marginBottom: '3rem' }}>
          <ProvidersSection />
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
