/**
 * Shared `@review-agent <command>` parser.
 *
 * Extracted from `handlers/webhook.ts` so that the CodeCommit receiver
 * (`handlers/codecommit-webhook.ts`) can reuse the exact same command
 * extraction logic as the GitHub handler. Behaviour is preserved
 * verbatim:
 *
 * - Matching is case-insensitive on the prefix (`@review-agent`).
 * - The first whitespace-delimited token after the prefix is the command.
 * - Non-`[a-z]` characters are stripped from the command (so trailing
 *   punctuation like `review.` becomes `review`).
 * - Returns `null` when the prefix is absent or no command word follows.
 */

export const COMMAND_PREFIX = '@review-agent';

export function parseCommand(commentBody: string): string | null {
  const lower = commentBody.toLowerCase();
  const idx = lower.indexOf(COMMAND_PREFIX);
  if (idx < 0) return null;
  const after = lower.slice(idx + COMMAND_PREFIX.length).trim();
  const word = after.split(/\s+/, 1)[0];
  if (!word) return null;
  return word.replace(/[^a-z]/g, '');
}

/**
 * Parsed `/feedback ...` command shape — v1.2 #95.
 *
 * The `/feedback` family is recognised in addition to the legacy
 * `@review-agent <command>` syntax so reviewers can leave explicit
 * accept / reject / dismiss signals on CodeCommit (which has no
 * reaction API) and as an alternative path on GitHub.
 *
 * Three subcommands map onto `FeedbackKind`:
 *
 * - `accept`  → `thumbs_up`
 * - `reject`  → `thumbs_down`
 * - `dismiss` → `dismissed`
 *
 * Both `accept` and `reject` optionally take a fingerprint-prefix
 * argument so the resolver can match the targeted comment when no
 * `<!-- fingerprint:<fp> -->` marker is present on the parent. The
 * prefix is required to be at least 8 lowercase hex characters to
 * keep the match unambiguous against the 16-hex full fingerprint
 * (`§7.7.1`). Anything shorter is treated as a malformed command.
 *
 * `dismiss` does not accept an argument — fingerprint targeting is
 * not meaningful for review-level dismissals (the writer routes
 * those to the summary review id, not a specific inline comment).
 */
export type FeedbackCommandKind = 'thumbs_up' | 'thumbs_down' | 'dismissed';

export type FeedbackCommand = {
  readonly kind: FeedbackCommandKind;
  readonly fpPrefix?: string;
};

export const FEEDBACK_COMMAND_PREFIX = '/feedback';

const MIN_FP_PREFIX_HEX_CHARS = 8;
const FP_PREFIX_REGEX = /^[0-9a-f]{8,}$/;

/**
 * Parse a `/feedback ...` command out of a comment body.
 *
 * Behaviour:
 *
 * - Prefix `/feedback` must appear (case-insensitive). Anything else
 *   returns `null` so callers can pass the body through the legacy
 *   `parseCommand` path without double-matching.
 * - The first whitespace-delimited token after the prefix is the
 *   subcommand. Unknown subcommands return `null`.
 * - For `accept` / `reject` an optional `<fp_prefix>` token follows.
 *   The prefix must be `[0-9a-f]{8,}` — shorter / mixed-case / non-hex
 *   prefixes return `null`. This is the "minimum 8 hex chars" guard
 *   the issue body asks for.
 * - Extra trailing tokens are tolerated (e.g. a user adding context).
 */
export function parseFeedbackCommand(commentBody: string): FeedbackCommand | null {
  const lower = commentBody.toLowerCase();
  const idx = lower.indexOf(FEEDBACK_COMMAND_PREFIX);
  if (idx < 0) return null;
  // Require the prefix to be at a word boundary so `pre/feedback`
  // doesn't accidentally match. The character immediately before the
  // prefix must be either the string start or a non-word character.
  if (idx > 0) {
    const before = lower.charCodeAt(idx - 1);
    // Allow whitespace / punctuation. Reject `[a-z0-9_]`.
    const isWordChar =
      (before >= 0x61 && before <= 0x7a) || (before >= 0x30 && before <= 0x39) || before === 0x5f;
    if (isWordChar) return null;
  }
  const after = lower.slice(idx + FEEDBACK_COMMAND_PREFIX.length).trim();
  if (after.length === 0) return null;
  const tokens = after.split(/\s+/);
  const sub = tokens[0];
  if (!sub) return null;
  const arg = tokens[1];

  if (sub === 'accept') {
    if (arg === undefined) return { kind: 'thumbs_up' };
    if (!isValidFpPrefix(arg)) return null;
    return { kind: 'thumbs_up', fpPrefix: arg };
  }
  if (sub === 'reject') {
    if (arg === undefined) return { kind: 'thumbs_down' };
    if (!isValidFpPrefix(arg)) return null;
    return { kind: 'thumbs_down', fpPrefix: arg };
  }
  if (sub === 'dismiss') {
    // `dismiss` does not take an argument; tolerate but ignore trailing
    // tokens so users can write `/feedback dismiss looks wrong here`.
    return { kind: 'dismissed' };
  }
  return null;
}

function isValidFpPrefix(s: string): boolean {
  if (s.length < MIN_FP_PREFIX_HEX_CHARS) return false;
  return FP_PREFIX_REGEX.test(s);
}
