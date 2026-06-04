import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { HowItWorksPage } from './how-it-works.js';

describe('HowItWorksPage', () => {
  it('renders the main heading', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByRole('heading', { name: 'How AI Review Works' })).toBeInTheDocument();
  });

  it('renders the intro paragraph', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    // The intro paragraph specifically mentions "read-only on source files"
    expect(screen.getByText(/It is strictly read-only on source files/i)).toBeInTheDocument();
  });

  it('renders all 7 pipeline step headings', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    // Step titles rendered as h3 inside the pipeline diagram
    expect(screen.getByText('Trigger')).toBeInTheDocument();
    expect(screen.getByText('Diff Analysis')).toBeInTheDocument();
    expect(screen.getByText('Context Preparation')).toBeInTheDocument();
    expect(screen.getByText('AI Review')).toBeInTheDocument();
    expect(screen.getByText('Safety Filters')).toBeInTheDocument();
    expect(screen.getByText('Finding Deduplication')).toBeInTheDocument();
    expect(screen.getByText('Post to PR')).toBeInTheDocument();
  });

  it('renders the safety section heading', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByRole('heading', { name: 'Safety Pillars' })).toBeInTheDocument();
  });

  it('renders the providers section heading', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByRole('heading', { name: 'Multi-Provider Support' })).toBeInTheDocument();
  });

  it('renders the Anthropic default badge', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    // default badge text
    expect(screen.getByText(/DEFAULT/i)).toBeInTheDocument();
  });

  it('renders the entry points section', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByText('GitHub Action')).toBeInTheDocument();
    expect(screen.getByText('Webhook (Lambda + SQS)')).toBeInTheDocument();
    expect(screen.getByText('CLI')).toBeInTheDocument();
  });

  it('renders the pipeline label', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByText('REVIEW PIPELINE')).toBeInTheDocument();
  });

  it('renders safety pillar: read-only tools', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByText('Read-Only Tools')).toBeInTheDocument();
  });

  it('renders safety pillar: secret scanning', () => {
    renderWithProviders(<HowItWorksPage />, { route: '/how-it-works' });
    expect(screen.getByText('Secret Scanning')).toBeInTheDocument();
  });
});
