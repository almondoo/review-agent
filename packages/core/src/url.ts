/**
 * URL extraction and allowlist helpers used by the mandatory URL
 * allowlist enforcement in `ReviewOutputSchema` (spec §7.3 #4 / §7.7).
 *
 * Pure, zero-I/O. Three concerns:
 *
 * 1. {@link extractUrls} pulls http(s) URLs out of free-form text
 *    (Markdown bodies, plain comment payloads). It is intentionally
 *    permissive about source format (Markdown links, code fences,
 *    inline prose) and conservative about what counts as the URL —
 *    common closing punctuation that almost never belongs inside a URL
 *    is excluded by the regex, and a small set of trailing sentence
 *    punctuation is then trimmed.
 * 2. {@link isPrefixAllowed} answers whether a URL begins with any of
 *    the configured `privacy.allowed_url_prefixes` entries.
 * 3. {@link isPrOwnRepoUrl} answers whether a URL points into the PR's
 *    own `<owner>/<repo>` path, regardless of host. Hosts are ignored
 *    so the same predicate works for github.com and GitHub Enterprise
 *    Server installations without requiring callers to enumerate
 *    GHES hostnames.
 */

// The URL deny set inside the character class excludes whitespace,
// the matching close characters of common bracketing constructs
// (`)`, `]`, `}`, `>`), and the three quote characters (`"`, `'`,
// `` ` ``). Markdown links of the form `[text](url)` naturally
// terminate at the `)`, and inline-code spans terminate at the
// backtick — without us having to parse Markdown.
const URL_PATTERN = /https?:\/\/[^\s)\]}<>"'`]+/g;

// Trailing punctuation that, when adjacent to a URL in prose, is
// almost always a sentence terminator rather than part of the URL
// itself. Stripped after extraction. We keep this list small on
// purpose; aggressive trimming would corrupt URLs that legitimately
// end with these characters (`!` and `?` appear in some path styles).
const TRAILING_PUNCT_PATTERN = /[.,;:!?]+$/;

/**
 * Extract every http(s) URL appearing in `text`.
 *
 * - Duplicates are preserved (the caller — the schema validator —
 *   needs to flag every occurrence, not just unique ones).
 * - Returns `[]` when the input has no http(s) URL.
 * - Trims a trailing run of `.,;:!?` from each match (sentence-end
 *   punctuation that the regex deliberately includes so the URL
 *   itself isn't split mid-segment by, e.g., a `?` that begins a
 *   query string).
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN);
  if (matches === null) {
    return [];
  }
  return matches.map((m) => m.replace(TRAILING_PUNCT_PATTERN, ''));
}

/**
 * Returns true iff `url` starts with one of `allowedPrefixes`.
 *
 * Comparison is exact-string `startsWith`: callers configure full
 * prefixes (typically including the scheme) and we do no
 * normalization here. An empty allowlist matches nothing — this is
 * the closed-world default required by §7.3 #4.
 */
export function isPrefixAllowed(url: string, allowedPrefixes: string[]): boolean {
  if (allowedPrefixes.length === 0) {
    return false;
  }
  return allowedPrefixes.some((prefix) => url.startsWith(prefix));
}

/**
 * Returns true iff `url`'s path begins with `/<owner>/<repo>`,
 * regardless of host. Used to grant the PR's own repository
 * permanent allowlist status without requiring it in the config
 * (§7.3 #4 "PR's own repo").
 *
 * Host is ignored so this predicate works uniformly for github.com
 * and any GitHub Enterprise Server hostname. Comparison is
 * case-insensitive. Query strings and fragments are ignored.
 *
 * Returns false on inputs that aren't parseable as a URL or whose
 * scheme isn't http/https — anything else would be a category mismatch
 * for "a link into this repo's web UI".
 */
export function isPrOwnRepoUrl(url: string, owner: string, repo: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  const prefix = `/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}
