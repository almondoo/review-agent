/**
 * Thin util for persisting the JWT session token in localStorage.
 * Key: review-agent.session-token
 */

const SESSION_TOKEN_KEY = 'review-agent.session-token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  localStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_TOKEN_KEY);
}
