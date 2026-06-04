import { useId } from 'react';
import { Outlet } from 'react-router-dom';
import { Footer } from './footer.js';
import { GrainOverlay } from './grain-overlay.js';
import { Header } from './header.js';

/**
 * Full-width layout — renders without the sidebar.
 * Used for onboarding flows (e.g. /integrations/github/repos) where the
 * sidebar navigation would be distracting and the page needs the full width.
 */
export function LayoutFullWidth() {
  const mainContentId = useId();
  return (
    <>
      <GrainOverlay />
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
        <Header />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <main
            id={mainContentId}
            style={{
              flex: 1,
              padding: '2rem',
              maxWidth: 'var(--max-width)',
            }}
          >
            <Outlet />
          </main>
          <Footer />
        </div>
      </div>
    </>
  );
}
