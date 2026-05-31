import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Layout } from './layout.js';

describe('Layout', () => {
  it('renders children inside main content area', () => {
    render(
      <MemoryRouter>
        <Layout>
          <p>Hello World</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders a main landmark element', () => {
    render(
      <MemoryRouter>
        <Layout>
          <span>content</span>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the header', () => {
    render(
      <MemoryRouter>
        <Layout>
          <span />
        </Layout>
      </MemoryRouter>,
    );
    // Header contains the logo text
    expect(screen.getByText('review-agent')).toBeInTheDocument();
  });

  it('renders sidebar navigation', () => {
    render(
      <MemoryRouter>
        <Layout>
          <span />
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
  });
});
