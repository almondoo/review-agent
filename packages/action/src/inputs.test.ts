import { describe, expect, it } from 'vitest';
import { parseInputs } from './inputs.js';

describe('parseInputs', () => {
  it('returns parsed inputs with sensible defaults', () => {
    const inputs = parseInputs({
      'github-token': 'ghs_x',
    });
    expect(inputs.githubToken).toBe('ghs_x');
    expect(inputs.language).toBe('en-US');
    expect(inputs.configPath).toBe('.review-agent.yml');
    expect(inputs.costCapUsd).toBe(1.0);
    expect(inputs.anthropicApiKey).toBeNull();
  });

  it('honors explicit language', () => {
    const inputs = parseInputs({ 'github-token': 't', language: 'ja-JP' });
    expect(inputs.language).toBe('ja-JP');
  });

  it('rejects unsupported language', () => {
    expect(() => parseInputs({ 'github-token': 't', language: 'xx-XX' })).toThrow(
      /not a supported/,
    );
  });

  it('rejects missing token', () => {
    expect(() => parseInputs({})).toThrow(/github-token/);
  });

  it('rejects non-positive cost cap', () => {
    expect(() => parseInputs({ 'github-token': 't', 'cost-cap-usd': '0' })).toThrow(/positive/);
    expect(() => parseInputs({ 'github-token': 't', 'cost-cap-usd': '-1' })).toThrow(/positive/);
    expect(() => parseInputs({ 'github-token': 't', 'cost-cap-usd': 'abc' })).toThrow(/positive/);
  });

  it('treats empty anthropic-api-key as null', () => {
    expect(
      parseInputs({ 'github-token': 't', 'anthropic-api-key': '' }).anthropicApiKey,
    ).toBeNull();
  });
});
