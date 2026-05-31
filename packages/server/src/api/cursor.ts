/**
 * Keyset-pagination cursor helpers shared across API routes.
 *
 * The cursor is opaque base64url-encoded JSON carrying `{ t, id }` where
 * `t` is an ISO timestamp string and `id` is the bigint row ID serialized
 * as a decimal string. Callers use `(created_at, id) DESC` ordering and
 * filter with `created_at < cursor.t` for the next page.
 */

/**
 * Escape SQL LIKE / ILIKE wildcard characters in a user-supplied string so
 * that `%`, `_`, and `\` are treated as literals rather than pattern
 * operators. Use together with `ilike(col, \`%${escapeLikePattern(s)}%\`)`.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export type DecodedCursor = { t: string; id: string };

export function encodeCursor(createdAt: Date, id: bigint): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id: id.toString() })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as DecodedCursor).t !== 'string' ||
      typeof (parsed as DecodedCursor).id !== 'string'
    ) {
      return null;
    }
    return parsed as DecodedCursor;
  } catch {
    return null;
  }
}
