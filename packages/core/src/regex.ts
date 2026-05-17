/**
 * Soft-validate a user-supplied regular expression pattern.
 *
 * Returns whether `new RegExp(pattern)` would succeed. Used by the
 * config schema's `.refine` on `privacy.redact_patterns` so a typo
 * fails at YAML load time rather than at runtime when we lift each
 * pattern into a gitleaks custom-rule TOML block (spec §7.4).
 *
 * Mirrors `isValidGlob`: empty strings and patterns containing a NUL
 * byte are rejected up-front so the failure modes between the two
 * privacy lists (`deny_paths` / `redact_patterns`) stay symmetric.
 * `.min(1)` on the Zod schema already covers empty strings, but
 * encoding it here keeps the helper safe to call from anywhere.
 */
// Built at module load via String.fromCharCode(0) — see note in
// `glob.ts` for the rationale (escape literals get expanded into a
// real 0x00 byte by some write tools on save).
const NUL_BYTE = String.fromCharCode(0);

export function isValidRegex(pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes(NUL_BYTE)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
