import type { ReactNode } from 'react';
import { useId } from 'react';
import { GrainOverlay } from './grain-overlay.js';
import { Header } from './header.js';
import { Sidebar } from './sidebar.js';

type LayoutProps = {
  children: ReactNode;
};

export function Layout({ children }: LayoutProps) {
  const mainContentId = useId();
  return (
    <>
      <GrainOverlay />
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
        <Header />
        <div style={{ display: 'flex', flex: 1 }}>
          <Sidebar />
          <main
            id={mainContentId}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '2rem',
              maxWidth: 'calc(var(--max-width) - var(--sidebar-width))',
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
