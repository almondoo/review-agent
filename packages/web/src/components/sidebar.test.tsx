import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Sidebar } from './sidebar.js';

function renderSidebar(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('renders the primary navigation landmark', () => {
    renderSidebar();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
  });

  it('renders all nav items', () => {
    renderSidebar();
    expect(screen.getByText('OVERVIEW')).toBeInTheDocument();
    expect(screen.getByText('REPOS')).toBeInTheDocument();
    expect(screen.getByText('INTEGRATIONS')).toBeInTheDocument();
    expect(screen.getByText('HISTORY')).toBeInTheDocument();
  });

  it('renders short codes for all nav items', () => {
    renderSidebar();
    expect(screen.getByText('OVW')).toBeInTheDocument();
    expect(screen.getByText('RPO')).toBeInTheDocument();
    expect(screen.getByText('INT')).toBeInTheDocument();
    expect(screen.getByText('HIS')).toBeInTheDocument();
  });

  it('renders version stamp', () => {
    renderSidebar();
    expect(screen.getByText(/v0\.0\.0/)).toBeInTheDocument();
  });

  it('nav links point to correct paths', () => {
    renderSidebar();
    const reposLink = screen.getByRole('link', { name: /REPOS/ });
    expect(reposLink).toHaveAttribute('href', '/repos');
  });
});
