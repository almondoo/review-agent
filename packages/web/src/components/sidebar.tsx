import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Hairline } from './hairline.js';

type NavItem = {
  path: string;
  labelKey: string;
  shortKey: string;
};

const NAV_ITEMS: NavItem[] = [
  { path: '/', labelKey: 'nav.overview', shortKey: 'nav.overviewShort' },
  { path: '/repos', labelKey: 'nav.repos', shortKey: 'nav.reposShort' },
  { path: '/integrations', labelKey: 'nav.integrations', shortKey: 'nav.integrationsShort' },
  { path: '/integrations/keys', labelKey: 'nav.byokKeys', shortKey: 'nav.byokKeysShort' },
  { path: '/history', labelKey: 'nav.history', shortKey: 'nav.historyShort' },
  { path: '/metrics', labelKey: 'nav.metrics', shortKey: 'nav.metricsShort' },
];

export function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside
      style={{
        width: 'var(--sidebar-width)',
        flexShrink: 0,
        borderRight: '1px solid var(--hairline)',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: '2rem',
        position: 'sticky',
        top: 'var(--header-height)',
        height: 'calc(100dvh - var(--header-height))',
        overflowY: 'auto',
      }}
    >
      {/* Vertical label */}
      <div
        style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.5625rem',
          fontWeight: 600,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          color: 'var(--graphite)',
          padding: '0 0.75rem',
          marginBottom: '2rem',
          userSelect: 'none',
          opacity: 0.5,
        }}
      >
        review-agent / nav
      </div>

      <Hairline style={{ marginBottom: '1rem' }} />

      <nav aria-label={t('nav.primaryNavigation')}>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                end={item.path === '/'}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.625rem 1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  fontWeight: isActive ? 700 : 400,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: isActive ? 'var(--rust)' : 'var(--fg)',
                  borderLeft: isActive ? '3px solid var(--rust)' : '3px solid transparent',
                  backgroundColor: isActive ? 'var(--bg-raised)' : 'transparent',
                  transition: 'all var(--transition-fast)',
                  textDecoration: 'none',
                })}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.5625rem',
                    color: 'var(--graphite)',
                    opacity: 0.6,
                    minWidth: '2rem',
                  }}
                >
                  {t(item.shortKey)}
                </span>
                {t(item.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Bottom spacer + version stamp */}
      <div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid var(--hairline)' }}>
        <span
          className="label-mono"
          style={{ color: 'var(--graphite)', opacity: 0.5, fontSize: '0.5625rem' }}
        >
          v0.0.0 / wave-17
        </span>
      </div>
    </aside>
  );
}
