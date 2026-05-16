import {
  REVIEW_STATE_SCHEMA_VERSION,
  type ReviewState,
  ReviewStateSchema,
} from '@review-agent/core';

const MARKER_OPEN = '<!-- review-agent-state:';
const MARKER_CLOSE = '-->';
const MARKER_REGEX = /<!--\s*review-agent-state:\s*([\s\S]*?)\s*-->/;

/**
 * Diagnostic events emitted by `parseStateComment` when the embedded
 * state JSON cannot be trusted. Callers (action / cli) wire these to
 * a logger + audit-log appender:
 *
 * - `schema_mismatch` -> log warning + emit `state_schema_mismatch`
 *   audit event, force a full review (treat as no previous state).
 * - `validation_failure` -> log warning, drop the previous state.
 * - `json_parse_failure` -> log warning, drop the previous state.
 */
export type StateParseEvent =
  | {
      readonly kind: 'schema_mismatch';
      readonly foundVersion: unknown;
      readonly expectedVersion: typeof REVIEW_STATE_SCHEMA_VERSION;
    }
  | { readonly kind: 'validation_failure'; readonly reason: string }
  | { readonly kind: 'json_parse_failure'; readonly reason: string };

export type StateParseEventHandler = (event: StateParseEvent) => void;

export function formatStateComment(state: ReviewState): string {
  return `${MARKER_OPEN} ${JSON.stringify(state)} ${MARKER_CLOSE}`;
}

export function parseStateComment(
  body: string,
  onEvent?: StateParseEventHandler,
): ReviewState | null {
  const match = MARKER_REGEX.exec(body);
  if (!match) return null;
  const json = match[1];
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    onEvent?.({
      kind: 'json_parse_failure',
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Detect schemaVersion mismatch before schema validation so the caller
  // can audit it distinctly. A forward-rolled state (future v2) needs
  // operator attention; a generally malformed state is silently dropped.
  if (typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed) {
    const foundVersion = (parsed as { schemaVersion: unknown }).schemaVersion;
    if (foundVersion !== REVIEW_STATE_SCHEMA_VERSION) {
      onEvent?.({
        kind: 'schema_mismatch',
        foundVersion,
        expectedVersion: REVIEW_STATE_SCHEMA_VERSION,
      });
      return null;
    }
  }

  const result = ReviewStateSchema.safeParse(parsed);
  if (!result.success) {
    onEvent?.({ kind: 'validation_failure', reason: result.error.message });
    return null;
  }
  return result.data;
}

export function buildSummaryWithState(humanReadable: string, state: ReviewState): string {
  return `${humanReadable.trimEnd()}\n\n${formatStateComment(state)}\n`;
}
