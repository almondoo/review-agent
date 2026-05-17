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
 *    own `<owner>/<repo>` path on the expected host. The host must
 *    match exactly (case-insensitive); callers pass `github.com` for
 *    SaaS or the GHES hostname for Enterprise. A previous host-agnostic
 *    design would have permitted `https://evil/<owner>/<repo>/...` to
 *    bypass the allowlist — see the inline note on `isPrOwnRepoUrl`.
 */

// The URL deny set inside the character class excludes whitespace,
// the matching close characters of common bracketing constructs
// (`)`, `]`, `}`, `>`), and the three quote characters (`"`, `'`,
// `` ` ``). Markdown links of the form `[text](url)` naturally
// terminate at the `)`, and inline-code spans terminate at the
// backtick — without us having to parse Markdown.
//
// `i` flag: schemes are matched case-insensitively. GitHub's Markdown
// renderer linkifies `HTTPS://...` / `Https://...` exactly like
// lowercase `https://...`, so the allowlist validator must see those
// variants too — otherwise a prompt-injection payload using mixed
// case bypasses the refine and the click-through reaches the user.
const URL_PATTERN = /https?:\/\/[^\s)\]}<>"'`]+/gi;

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
 * Returns true iff `url` points into the PR's own repository — that
 * is, its host matches `expected.host` (case-insensitive, exact) AND
 * its path begins with `/<expected.owner>/<expected.repo>`
 * (case-insensitive). Used to grant the PR's own repository
 * permanent allowlist status without requiring it in the config
 * (spec §7.3 #4 "PR's own repo").
 *
 * Host MUST match exactly: a previous design that ignored host would
 * have permitted `https://evil.example/<owner>/<repo>/log?secret=...`
 * to slip through the allowlist when the PR's repo is
 * `<owner>/<repo>` — exactly the exfiltration channel §7.3 #4 is
 * meant to block. Callers pass the actual PR host (github.com for
 * SaaS, the GHES hostname for Enterprise) so the predicate works
 * uniformly across deployments.
 *
 * `URL` parsing normalizes the scheme casing (`new URL('HTTPS://x')`
 * yields `protocol === 'https:'`), and `parsed.host` deliberately
 * excludes any userinfo (`user:pass@evil.com` → `parsed.host` is
 * `evil.com`), so userinfo spoofing cannot pass as a github.com URL.
 * Query strings and fragments are ignored.
 *
 * Returns false on inputs that aren't parseable as a URL or whose
 * scheme isn't http/https — anything else would be a category mismatch
 * for "a link into this repo's web UI".
 *
 * @param expected.host - hostname (case-insensitive). Include the port
 *   for non-default ports (e.g. `'ghe.example.com:8443'`). Recommended
 *   derivation: `new URL(pr.html_url).host` so the port is included
 *   automatically when present.
 */
export function isPrOwnRepoUrl(
  url: string,
  expected: { host: string; owner: string; repo: string },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.host.toLowerCase() !== expected.host.toLowerCase()) {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  const prefix = `/${expected.owner.toLowerCase()}/${expected.repo.toLowerCase()}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}
