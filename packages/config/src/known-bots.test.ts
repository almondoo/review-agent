import { describe, expect, it } from 'vitest';
import { isKnownReviewBotLogin, KNOWN_REVIEW_BOT_LOGINS } from './known-bots.js';

describe('KNOWN_REVIEW_BOT_LOGINS', () => {
  it('includes the four bots called out in the v1.0 #48 acceptance criteria', () => {
    // Pinned to the acceptance-criteria list in issue #48 so adding a
    // new bot to the constant doesn't silently drop one of the
    // canonical four. New entries are additive.
    for (const expected of [
      'coderabbitai[bot]',
      'qodo-merge[bot]',
      'pr-agent-bot[bot]',
      'bedrock-pr-reviewer[bot]',
    ]) {
      expect(KNOWN_REVIEW_BOT_LOGINS).toContain(expected);
    }
  });

  it('only lists [bot]-suffixed App actors (no plain users)', () => {
    // Operator overrides go in `coordination.other_bots_logins`. The
    // built-in list is for App actors only — a plain login here would
    // make the substring/case-insensitive false-positive risk worse.
    for (const login of KNOWN_REVIEW_BOT_LOGINS) {
      expect(login).toMatch(/\[bot\]$/);
    }
  });
});

describe('isKnownReviewBotLogin', () => {
  it('recognises a known bot login', () => {
    expect(isKnownReviewBotLogin('coderabbitai[bot]')).toBe(true);
  });

  it('rejects unknown logins (no partial / case-insensitive match)', () => {
    expect(isKnownReviewBotLogin('coderabbit-fan')).toBe(false);
    expect(isKnownReviewBotLogin('CodeRabbitAI[bot]')).toBe(false);
    expect(isKnownReviewBotLogin('human-reviewer')).toBe(false);
  });
});
