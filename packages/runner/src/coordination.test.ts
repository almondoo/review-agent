import { describe, expect, it } from 'vitest';
import { decideCoordination, renderDeferralSummary } from './coordination.js';

describe('decideCoordination', () => {
  it('returns proceed when mode is ignore even if a known bot is present', () => {
    const decision = decideCoordination({
      mode: 'ignore',
      botLogins: ['coderabbitai[bot]'],
      existingCommentAuthors: ['coderabbitai[bot]', 'human-reviewer'],
    });
    expect(decision).toEqual({ action: 'proceed' });
  });

  it('defers when a known bot has commented and mode is defer_if_present', () => {
    const decision = decideCoordination({
      mode: 'defer_if_present',
      botLogins: ['coderabbitai[bot]', 'qodo-merge[bot]'],
      existingCommentAuthors: ['human-reviewer', 'coderabbitai[bot]'],
    });
    expect(decision).toEqual({ action: 'defer', bot: 'coderabbitai[bot]' });
  });

  it('returns proceed when defer_if_present but no matching bot found', () => {
    const decision = decideCoordination({
      mode: 'defer_if_present',
      botLogins: ['coderabbitai[bot]'],
      existingCommentAuthors: ['human-reviewer', 'github-actions[bot]'],
    });
    expect(decision).toEqual({ action: 'proceed' });
  });

  it('matches only on exact login (no partial / case-insensitive)', () => {
    // Substring or case-insensitive matches would falsely trip on a
    // human reviewer named `coderabbit-fan`.
    const decision = decideCoordination({
      mode: 'defer_if_present',
      botLogins: ['coderabbitai[bot]'],
      existingCommentAuthors: ['CodeRabbitAI[bot]', 'coderabbit-fan', 'coderabbitai'],
    });
    expect(decision).toEqual({ action: 'proceed' });
  });

  it('honours operator-supplied additional logins via the merged botLogins list', () => {
    // The wiring layer is responsible for unioning the built-in allowlist
    // with `coordination.other_bots_logins`. This test confirms the
    // detection function uses the full list as-is — i.e. extension works.
    const decision = decideCoordination({
      mode: 'defer_if_present',
      botLogins: ['coderabbitai[bot]', 'acme-internal-reviewer[bot]'],
      existingCommentAuthors: ['acme-internal-reviewer[bot]'],
    });
    expect(decision).toEqual({ action: 'defer', bot: 'acme-internal-reviewer[bot]' });
  });

  it('returns proceed against an empty author list', () => {
    expect(
      decideCoordination({
        mode: 'defer_if_present',
        botLogins: ['coderabbitai[bot]'],
        existingCommentAuthors: [],
      }),
    ).toEqual({ action: 'proceed' });
  });

  it('returns proceed against an empty bot list (no known reviewers configured)', () => {
    expect(
      decideCoordination({
        mode: 'defer_if_present',
        botLogins: [],
        existingCommentAuthors: ['coderabbitai[bot]'],
      }),
    ).toEqual({ action: 'proceed' });
  });
});

describe('renderDeferralSummary', () => {
  it('mentions the detected bot login by name', () => {
    const body = renderDeferralSummary('coderabbitai[bot]');
    expect(body).toContain('coderabbitai[bot]');
    expect(body).toContain('skipped');
    expect(body).toContain('coordination.other_bots');
  });
});
