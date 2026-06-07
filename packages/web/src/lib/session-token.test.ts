import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSessionToken, getSessionToken, setSessionToken } from './session-token.js';

describe('session-token', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('getSessionToken returns null when no token is stored', () => {
    expect(getSessionToken()).toBeNull();
  });

  it('setSessionToken stores the token', () => {
    setSessionToken('test-jwt-abc');
    expect(getSessionToken()).toBe('test-jwt-abc');
  });

  it('clearSessionToken removes the stored token', () => {
    setSessionToken('test-jwt-abc');
    clearSessionToken();
    expect(getSessionToken()).toBeNull();
  });

  it('overwrites an existing token when setSessionToken is called again', () => {
    setSessionToken('token-1');
    setSessionToken('token-2');
    expect(getSessionToken()).toBe('token-2');
  });
});
