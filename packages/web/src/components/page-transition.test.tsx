import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PageTransition, StaggerContainer, StaggerItem } from './page-transition.js';

describe('PageTransition', () => {
  it('renders children', () => {
    render(
      <MemoryRouter>
        <PageTransition>
          <p>Page content</p>
        </PageTransition>
      </MemoryRouter>,
    );
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });
});

describe('StaggerContainer', () => {
  it('renders children', () => {
    render(
      <StaggerContainer>
        <span>child</span>
      </StaggerContainer>,
    );
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('accepts an optional style prop', () => {
    const { container } = render(
      <StaggerContainer style={{ padding: '1rem' }}>
        <span>styled</span>
      </StaggerContainer>,
    );
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it('renders without style prop (exactOptionalPropertyTypes path)', () => {
    render(
      <StaggerContainer>
        <span>no-style</span>
      </StaggerContainer>,
    );
    expect(screen.getByText('no-style')).toBeInTheDocument();
  });
});

describe('StaggerItem', () => {
  it('renders children', () => {
    render(
      <StaggerItem>
        <span>item</span>
      </StaggerItem>,
    );
    expect(screen.getByText('item')).toBeInTheDocument();
  });

  it('accepts an optional style prop', () => {
    render(
      <StaggerItem style={{ color: 'red' }}>
        <span>styled-item</span>
      </StaggerItem>,
    );
    expect(screen.getByText('styled-item')).toBeInTheDocument();
  });

  it('renders without style prop (exactOptionalPropertyTypes path)', () => {
    render(
      <StaggerItem>
        <span>bare-item</span>
      </StaggerItem>,
    );
    expect(screen.getByText('bare-item')).toBeInTheDocument();
  });
});
