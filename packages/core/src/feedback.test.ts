import { describe, expect, it } from 'vitest';
import { FEEDBACK_KINDS, feedbackKindToFactType } from './feedback.js';

describe('FEEDBACK_KINDS', () => {
  it('contains exactly thumbs_up, thumbs_down, dismissed', () => {
    expect(FEEDBACK_KINDS).toEqual(['thumbs_up', 'thumbs_down', 'dismissed']);
  });

  it('has three elements', () => {
    expect(FEEDBACK_KINDS).toHaveLength(3);
  });
});

describe('feedbackKindToFactType', () => {
  it('maps thumbs_up to accepted_pattern', () => {
    expect(feedbackKindToFactType('thumbs_up')).toBe('accepted_pattern');
  });

  it('maps thumbs_down to rejected_finding', () => {
    expect(feedbackKindToFactType('thumbs_down')).toBe('rejected_finding');
  });

  it('maps dismissed to rejected_finding', () => {
    expect(feedbackKindToFactType('dismissed')).toBe('rejected_finding');
  });

  it('maps every non-thumbs_up kind to rejected_finding', () => {
    const nonAccepted = FEEDBACK_KINDS.filter((k) => k !== 'thumbs_up');
    for (const kind of nonAccepted) {
      expect(feedbackKindToFactType(kind)).toBe('rejected_finding');
    }
  });
});
