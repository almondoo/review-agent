// Extraction helpers for unknown errors. Used wherever we receive an
// `unknown` (catch blocks, async callbacks, third-party SDK rejections)
// and need to pull the HTTP status code or a human-readable message
// out without committing to a specific Error subclass.
//
// Kept in `core` because both the action retry helper and the
// runner/cli error reporters need the same extraction logic — duplicating
// it would let the two diverge silently. `core` stays zero-I/O: these
// functions never read `process.env`, never touch the filesystem, never
// import a provider SDK.

/**
 * Pull a numeric HTTP status code out of an unknown error. Tolerates:
 *
 *   * `{ status: 503 }`                    — fetch-style errors
 *   * `{ response: { status: 404 } }`      — Octokit / Axios wrappers
 *
 * Returns `null` when no status field is present (network errors,
 * non-HTTP failures, primitives, `null`, `undefined`).
 */
export function extractStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const candidate = (err as { status?: unknown }).status;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    const response = (err as { response?: unknown }).response;
    if (response && typeof response === 'object') {
      const inner = (response as { status?: unknown }).status;
      if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
    }
  }
  return null;
}

/**
 * Coerce an unknown error into a human-readable string suitable for
 * logging or surfacing to the LLM. Never throws; never invokes
 * `JSON.stringify` (which can throw on cycles or BigInt values).
 */
export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
