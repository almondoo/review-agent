import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Layout } from './layout.js';

function makeRouter(childElement: React.ReactElement) {
  return createMemoryRouter([
    {
      element: <Layout />,
      children: [{ path: '/', element: childElement }],
    },
  ]);
}

describe('Layout', () => {
  it('renders child route content inside main content area', () => {
    render(<RouterProvider router={makeRouter(<p>Hello World</p>)} />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders a main landmark element', () => {
    render(<RouterProvider router={makeRouter(<span>content</span>)} />);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the header', () => {
    render(<RouterProvider router={makeRouter(<span />)} />);
    // Header contains the logo text
    expect(screen.getByText('review-agent')).toBeInTheDocument();
  });

  it('renders sidebar navigation', () => {
    render(<RouterProvider router={makeRouter(<span />)} />);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
  });
});
