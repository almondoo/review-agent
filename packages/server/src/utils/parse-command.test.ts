import { describe, expect, it } from 'vitest';
import {
  COMMAND_PREFIX,
  FEEDBACK_COMMAND_PREFIX,
  parseCommand,
  parseFeedbackCommand,
} from './parse-command.js';

describe('parseCommand', () => {
  it('returns null when prefix is absent', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  it('returns null when prefix is present but no command follows', () => {
    expect(parseCommand('@review-agent')).toBeNull();
    expect(parseCommand('@review-agent   ')).toBeNull();
  });

  it('extracts the first word after the prefix', () => {
    expect(parseCommand('@review-agent review')).toBe('review');
  });

  it('is case-insensitive on the prefix and command', () => {
    expect(parseCommand('@ReView-AGent REVIEW')).toBe('review');
  });

  it('ignores leading text before the prefix', () => {
    expect(parseCommand('thanks! @review-agent review please')).toBe('review');
  });

  it('strips trailing punctuation from the command', () => {
    expect(parseCommand('@review-agent review.')).toBe('review');
    expect(parseCommand('@review-agent review!')).toBe('review');
  });

  it('strips embedded non-alpha characters from the command', () => {
    expect(parseCommand('@review-agent re-view')).toBe('review');
  });

  it('returns the remaining lowercase letters when prefix is followed by only punctuation', () => {
    expect(parseCommand('@review-agent !!!')).toBe('');
  });

  it('exports the canonical prefix string', () => {
    expect(COMMAND_PREFIX).toBe('@review-agent');
  });
});

describe('parseFeedbackCommand', () => {
  it('exports the canonical /feedback prefix string', () => {
    expect(FEEDBACK_COMMAND_PREFIX).toBe('/feedback');
  });

  it('returns null when the body has no /feedback prefix', () => {
    expect(parseFeedbackCommand('hello world')).toBeNull();
    expect(parseFeedbackCommand('@review-agent review')).toBeNull();
  });

  it('parses /feedback accept (no fp_prefix)', () => {
    expect(parseFeedbackCommand('/feedback accept')).toEqual({ kind: 'thumbs_up' });
  });

  it('parses /feedback reject (no fp_prefix)', () => {
    expect(parseFeedbackCommand('/feedback reject')).toEqual({ kind: 'thumbs_down' });
  });

  it('parses /feedback accept <fp_prefix>', () => {
    expect(parseFeedbackCommand('/feedback accept abcd1234')).toEqual({
      kind: 'thumbs_up',
      fpPrefix: 'abcd1234',
    });
  });

  it('parses /feedback reject <fp_prefix> with a longer prefix', () => {
    expect(parseFeedbackCommand('/feedback reject deadbeef01234567')).toEqual({
      kind: 'thumbs_down',
      fpPrefix: 'deadbeef01234567',
    });
  });

  it('parses /feedback dismiss', () => {
    expect(parseFeedbackCommand('/feedback dismiss')).toEqual({ kind: 'dismissed' });
  });

  it('tolerates trailing free text after /feedback dismiss', () => {
    expect(parseFeedbackCommand('/feedback dismiss this review is wrong')).toEqual({
      kind: 'dismissed',
    });
  });

  it('is case-insensitive on the subcommand', () => {
    expect(parseFeedbackCommand('/FEEDBACK Accept')).toEqual({ kind: 'thumbs_up' });
    expect(parseFeedbackCommand('/Feedback REJECT')).toEqual({ kind: 'thumbs_down' });
  });

  it('lower-cases the fp_prefix via the input lower-casing pass', () => {
    // The parser lowercases the entire body before matching, so upper
    // case hex digits round-trip safely through to the resolver.
    expect(parseFeedbackCommand('/feedback reject ABCD1234')).toEqual({
      kind: 'thumbs_down',
      fpPrefix: 'abcd1234',
    });
  });

  it('rejects fp_prefix shorter than 8 hex chars', () => {
    expect(parseFeedbackCommand('/feedback reject abc')).toBeNull();
    expect(parseFeedbackCommand('/feedback accept abc1234')).toBeNull();
  });

  it('rejects fp_prefix containing non-hex characters', () => {
    expect(parseFeedbackCommand('/feedback accept xyzabcde')).toBeNull();
    expect(parseFeedbackCommand('/feedback reject abcd123!')).toBeNull();
  });

  it('returns null on an unknown subcommand', () => {
    expect(parseFeedbackCommand('/feedback maybe')).toBeNull();
    expect(parseFeedbackCommand('/feedback approve')).toBeNull();
  });

  it('returns null when no subcommand follows /feedback', () => {
    expect(parseFeedbackCommand('/feedback')).toBeNull();
    expect(parseFeedbackCommand('/feedback   ')).toBeNull();
  });

  it('ignores leading text and matches the prefix at a word boundary', () => {
    expect(parseFeedbackCommand('thanks! /feedback accept')).toEqual({ kind: 'thumbs_up' });
  });

  it('does not match /feedback when it appears inside another word', () => {
    expect(parseFeedbackCommand('pre/feedback accept')).toBeNull();
    expect(parseFeedbackCommand('a/feedback reject deadbeef')).toBeNull();
  });

  it('does not match /feedback when preceded by a digit (word boundary)', () => {
    expect(parseFeedbackCommand('5/feedback accept')).toBeNull();
  });

  it('does not match /feedback when preceded by an underscore (word boundary)', () => {
    expect(parseFeedbackCommand('x_/feedback accept')).toBeNull();
  });
});
