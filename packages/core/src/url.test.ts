import { describe, expect, it } from 'vitest';
import { extractUrls, isPrefixAllowed, isPrOwnRepoUrl } from './url.js';

describe('extractUrls', () => {
  it('returns [] for an empty string', () => {
    expect(extractUrls('')).toEqual([]);
  });

  it('returns [] when no http(s) URL is present', () => {
    expect(extractUrls('see the README and ftp://example.com/file for details')).toEqual([]);
  });

  it('extracts a single bare URL', () => {
    expect(extractUrls('visit https://example.com today')).toEqual(['https://example.com']);
  });

  it('extracts multiple URLs in order and preserves duplicates', () => {
    const text = 'a https://a.example/x then https://b.example/y and again https://a.example/x';
    expect(extractUrls(text)).toEqual([
      'https://a.example/x',
      'https://b.example/y',
      'https://a.example/x',
    ]);
  });

  it('strips trailing sentence punctuation `.,;:!?` from extracted URLs', () => {
    expect(extractUrls('see https://example.com/path. for context')).toEqual([
      'https://example.com/path',
    ]);
    expect(
      extractUrls('one https://a.example, two https://b.example; three https://c.example!'),
    ).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    expect(extractUrls('really? https://example.com?')).toEqual(['https://example.com']);
  });

  it('extracts URLs from Markdown link syntax `[text](url)` without including the closing paren', () => {
    expect(extractUrls('see [docs](https://example.com/docs) for more')).toEqual([
      'https://example.com/docs',
    ]);
  });

  it('extracts URLs even inside fenced code blocks', () => {
    const text = '```\ncurl https://example.com/api\n```';
    expect(extractUrls(text)).toEqual(['https://example.com/api']);
  });

  it('extracts both http and https URLs', () => {
    expect(extractUrls('plain http://example.com and secure https://example.com')).toEqual([
      'http://example.com',
      'https://example.com',
    ]);
  });

  it('keeps query string and fragment when they are part of the URL', () => {
    expect(extractUrls('look at https://example.com/path?q=1&p=2#section now')).toEqual([
      'https://example.com/path?q=1&p=2#section',
    ]);
  });

  // Regression: GitHub renderer linkifies mixed-case schemes, so the
  // allowlist refine must see them too. Without case-insensitive
  // matching, `HTTPS://evil.com/leak` slips past `extractUrls` and
  // the URL allowlist refine is bypassed entirely.
  it('matches mixed-case http(s) schemes (HTTPS, Https, hTTpS)', () => {
    expect(extractUrls('see HTTPS://example.com/x')).toEqual(['HTTPS://example.com/x']);
    expect(extractUrls('see Https://example.com/y')).toEqual(['Https://example.com/y']);
    expect(extractUrls('see hTTpS://example.com/z')).toEqual(['hTTpS://example.com/z']);
    expect(extractUrls('see HTTP://example.com/q')).toEqual(['HTTP://example.com/q']);
  });
});

describe('isPrefixAllowed', () => {
  it('returns false for an empty allowlist (closed-world default)', () => {
    expect(isPrefixAllowed('https://example.com/anything', [])).toBe(false);
  });

  it('returns true when a configured prefix matches the URL start', () => {
    expect(
      isPrefixAllowed('https://github.com/owner/repo/pull/1', ['https://github.com/owner/repo/']),
    ).toBe(true);
  });

  it('returns false when none of the prefixes match', () => {
    expect(
      isPrefixAllowed('https://example.com/x', ['https://github.com/', 'https://gitlab.com/']),
    ).toBe(false);
  });

  it('returns false when the prefix is longer than the URL', () => {
    expect(isPrefixAllowed('https://example.com', ['https://example.com/very/deep/path'])).toBe(
      false,
    );
  });

  it('matches the first prefix in the list that satisfies the URL', () => {
    expect(
      isPrefixAllowed('https://docs.example.com/api', [
        'https://other.example.com/',
        'https://docs.example.com/',
      ]),
    ).toBe(true);
  });
});

describe('isPrOwnRepoUrl', () => {
  const GH = { host: 'github.com', owner: 'owner', repo: 'repo' };

  it('returns true for a URL pointing into the PR own repo on the configured host', () => {
    expect(isPrOwnRepoUrl('https://github.com/owner/repo/pull/1', GH)).toBe(true);
  });

  it('returns true for the bare repo root', () => {
    expect(isPrOwnRepoUrl('https://github.com/owner/repo', GH)).toBe(true);
  });

  it('returns false for a different repo under the same owner', () => {
    expect(isPrOwnRepoUrl('https://github.com/owner/other/pull/1', GH)).toBe(false);
  });

  it('returns false for a different owner', () => {
    expect(isPrOwnRepoUrl('https://github.com/someone/repo/pull/1', GH)).toBe(false);
  });

  it('returns false when the path is a prefix-collision sibling (`/owner/repo-other`)', () => {
    expect(isPrOwnRepoUrl('https://github.com/owner/repo-other/issues/1', GH)).toBe(false);
  });

  it('compares owner/repo case-insensitively', () => {
    expect(isPrOwnRepoUrl('https://github.com/Owner/REPO/pull/2', GH)).toBe(true);
    expect(
      isPrOwnRepoUrl('https://github.com/owner/repo/pull/2', {
        host: 'github.com',
        owner: 'OWNER',
        repo: 'Repo',
      }),
    ).toBe(true);
  });

  it('matches when expected.host is a GHES hostname', () => {
    expect(
      isPrOwnRepoUrl('https://ghe.example.com/owner/repo/pull/3', {
        host: 'ghe.example.com',
        owner: 'owner',
        repo: 'repo',
      }),
    ).toBe(true);
  });

  it('handles query strings and fragments without affecting the path match', () => {
    expect(isPrOwnRepoUrl('https://github.com/owner/repo/pull/1?diff=split#R10', GH)).toBe(true);
  });

  it('returns false for non-http(s) schemes', () => {
    expect(isPrOwnRepoUrl('ftp://github.com/owner/repo/x', GH)).toBe(false);
  });

  it('returns false for unparseable URL input', () => {
    expect(isPrOwnRepoUrl('not a url', GH)).toBe(false);
  });

  // Regression for reviewer C-2: a URL with the same path under a
  // different host MUST NOT be treated as own-repo. Previously this
  // permitted `https://evil.example/<owner>/<repo>/log?secret=...`
  // to bypass the allowlist and become a one-click exfil channel.
  it('returns false when host differs from expected.host (closes spec §7.3 #4 host-spoof channel)', () => {
    expect(isPrOwnRepoUrl('https://evil.example/owner/repo/log?secret=abc', GH)).toBe(false);
    expect(isPrOwnRepoUrl('https://ghe.example.com/owner/repo/pull/1', GH)).toBe(false);
  });

  // Regression: `user:pass@evil.com` puts evil.com in `parsed.host`
  // (userinfo isn't part of host), so this MUST NOT match a
  // github.com expected host. Verifying the parser behavior holds
  // catches future regressions if we ever switch URL parsers.
  it('returns false for userinfo-spoofed hosts (`user:pass@evil.com`)', () => {
    expect(isPrOwnRepoUrl('https://github.com:pass@evil.com/owner/repo/x', GH)).toBe(false);
  });

  it('compares host case-insensitively and accepts mixed-case schemes', () => {
    expect(isPrOwnRepoUrl('HTTPS://GITHUB.COM/owner/repo/pull/1', GH)).toBe(true);
    expect(isPrOwnRepoUrl('Https://GitHub.com/owner/repo', GH)).toBe(true);
  });
});
