import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LayoutFullWidth } from './layout-full-width.js';

function makeRouter(childElement: React.ReactElement) {
  return createMemoryRouter([
    {
      element: <LayoutFullWidth />,
      children: [{ path: '/', element: childElement }],
    },
  ]);
}

describe('LayoutFullWidth', () => {
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
    expect(screen.getByText('review-agent')).toBeInTheDocument();
  });

  it('does not render sidebar navigation', () => {
    render(<RouterProvider router={makeRouter(<span />)} />);
    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
    ).not.toBeInTheDocument();
  });
});
