import { describe, expect, it } from 'vitest';
import { COMMAND_PREFIX, parseCommand } from './parse-command.js';

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
