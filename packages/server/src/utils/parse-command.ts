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
