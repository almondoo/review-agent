import type { ReviewState } from '@review-agent/core';

const MARKER_OPEN = '<!-- review-agent-state:';
const MARKER_CLOSE = '-->';
const MARKER_REGEX = /<!--\s*review-agent-state:\s*([\s\S]*?)\s*-->/;

export function formatStateComment(state: ReviewState): string {
  return `${MARKER_OPEN} ${JSON.stringify(state)} ${MARKER_CLOSE}`;
}

export function parseStateComment(body: string): ReviewState | null {
  const match = MARKER_REGEX.exec(body);
  if (!match) return null;
  const json = match[1];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!isReviewState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildSummaryWithState(humanReadable: string, state: ReviewState): string {
  return `${humanReadable.trimEnd()}\n\n${formatStateComment(state)}\n`;
}

function isReviewState(value: unknown): value is ReviewState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    typeof v.lastReviewedSha === 'string' &&
    typeof v.baseSha === 'string' &&
    typeof v.reviewedAt === 'string' &&
    typeof v.modelUsed === 'string' &&
    typeof v.totalTokens === 'number' &&
    typeof v.totalCostUsd === 'number' &&
    Array.isArray(v.commentFingerprints) &&
    v.commentFingerprints.every((f) => typeof f === 'string')
  );
}
