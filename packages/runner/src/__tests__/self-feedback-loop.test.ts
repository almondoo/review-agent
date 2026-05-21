import { fingerprint } from '@review-agent/core';
import type { LlmProvider, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { runReview } from '../agent.js';
import { createFeedbackWriter, type ReviewHistoryWriter } from '../feedback-writer.js';
import type { ReviewJob } from '../types.js';

// v1.2 #108 — Phase 3 → Phase 4 self-feedback round-trip.
//
// **Scope note**: the issue body suggests
// `packages/runner/src/__tests__/self-feedback-loop.integration.test.ts`
// gated on `TEST_DATABASE_APP_URL`. The `@review-agent/runner` package
// does NOT currently depend on `@review-agent/db` (the runner's
// `ReviewHistoryWriter` / `historyReader` are abstract function types
// the worker layer fulfils — adding a real Postgres workspace dep to
// the runner would invert the direction of `db` → `runner` cleanly
// enforced by `server`).
//
// The actual risk identified in the issue's Motivation section —
// "the `[fp:<fingerprint>]` prefix is the ONLY link between Phase 3
// writer and Phase 4 reader; a silent format mismatch makes the
// whole loop go quiet" — is **protocol-level**, not driver-level.
// We pin the protocol here with an in-memory store that exercises:
//
//   * createFeedbackWriter() encodes `[fp:<fp>] ...` correctly.
//   * The same fingerprint that `runReview` attached on review #1
//     is what the writer persists.
//   * On review #2, the runner's `historyReader` returns the row
//     and the dedup middleware drops the matching comment via
//     `droppedByFeedback`.
//
// A Postgres-backed integration test that simply replays this same
// pattern through `createReviewHistoryWriter` + `loadRecentReviewHistory`
// from `@review-agent/db` would catch driver-layer regressions (RLS
// GUC propagation, expires_at default expression) — covered by
// `packages/db/src/__tests__/integration.test.ts` for the writer /
// reader unit halves, and by `migration-compat.integration.test.ts`
// (#107) for the schema invariants. Stitching those two halves into
// a runner-side integration test is tracked as a follow-up if the
// runner ever gains a `@review-agent/db` devDep.

const baseJob: ReviewJob = {
  jobId: 'job-self-feedback',
  workspaceDir: '/tmp/job-self-feedback',
  diffText: 'diff --git a/x b/x',
  prMetadata: { title: 'feature', body: '', author: 'alice' },
  previousState: null,
  profile: 'TS-only.',
  pathInstructions: [],
  skills: [],
  language: 'en-US',
  costCapUsd: 2.0,
  pathFilters: [],
  maxFiles: 50,
  maxDiffLines: 3000,
  privacy: { allowedUrlPrefixes: [], denyPaths: [], redactPatterns: [] },
  prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
};

// Deterministic LLM output — one finding the model will emit on
// every review.
const stableComment = {
  path: 'src/auth.ts',
  line: 10,
  side: 'RIGHT' as const,
  body: 'Use parameterized query.',
  severity: 'major' as const,
  ruleId: 'sql-injection',
};

const validOutput: ReviewOutput = {
  summary: 'One finding.',
  comments: [stableComment],
  tokensUsed: { input: 200, output: 50 },
  costUsd: 0.001,
};

function makeProvider(): LlmProvider {
  return {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    classifyError: vi.fn(() => ({ kind: 'fatal' as const })),
    pricePerMillionTokens: vi.fn(() => ({ input: 3, output: 15 })),
    estimateCost: vi.fn(async () => ({ inputTokens: 200, estimatedUsd: 0.001 })),
    generateReview: vi.fn(async () => validOutput),
  };
}

// In-memory store playing the role of the `review_history` table.
type StoredRow = {
  readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision';
  readonly factText: string;
};

function makeStore(): {
  readonly writer: ReviewHistoryWriter;
  readonly rows: ReadonlyArray<StoredRow>;
} {
  const rows: StoredRow[] = [];
  const writer: ReviewHistoryWriter = async (input) => {
    rows.push({ factType: input.factType, factText: input.factText });
  };
  return {
    writer,
    get rows() {
      return rows;
    },
  };
}

describe('self-feedback loop — Phase 3 writer → Phase 4 reader round-trip (#108)', () => {
  it('the fingerprint the writer persists is recoverable by the reader, and dedup drops the matching comment on review #2', async () => {
    const provider = makeProvider();
    const store = makeStore();

    // Review #1 — capture the fingerprint the dedup middleware
    // attached to the stable comment.
    const r1 = await runReview(baseJob, provider);
    expect(r1.comments).toHaveLength(1);
    const fp = r1.comments[0]?.fingerprint;
    expect(fp).toBeTruthy();
    expect(fp).toBe(
      // Sanity-pin: the runner uses (path, line, ruleId, suggestionType)
      // — a future change to suggestionType / ruleId fallback would
      // break this match silently in real deployments.
      fingerprint({
        path: stableComment.path,
        line: stableComment.line,
        ruleId: stableComment.ruleId,
        suggestionType: 'comment',
      }),
    );

    // Phase 3 — operator reacts 👎 on the comment. The writer
    // encodes `[fp:<fp>] ...` into factText (single source of truth
    // shared with Phase 4 below).
    const feedback = createFeedbackWriter({ writer: store.writer });
    const result = await feedback.record({
      installationId: 4242n,
      repo: 'almondoo/review-agent',
      kind: 'thumbs_down',
      fingerprint: fp ?? '',
      factText: stableComment.body,
    });
    expect(result.dropped).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.factType).toBe('rejected_finding');
    expect(store.rows[0]?.factText.startsWith(`[fp:${fp}] `)).toBe(true);

    // Phase 4 — historyReader returns the persisted rows. The
    // runner extracts the `[fp:<fp>]` prefix and feeds it into
    // dedup as `rejectedFingerprints`.
    const r2 = await runReview(baseJob, provider, {
      historyReader: async () => store.rows,
      evalContext: { installationId: 4242n, prNumber: 7, headSha: 'h' },
    });
    expect(r2.droppedByFeedback).toBe(1);
    expect(r2.comments).toHaveLength(0);
    // System prompt must include the <learned_facts> envelope so the
    // model also sees the operator's signal in addition to the
    // post-LLM dedup backstop.
    const sysPrompt = (provider.generateReview as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
      ?.systemPrompt as string;
    expect(sysPrompt).toContain('<learned_facts>');
    expect(sysPrompt).toContain(stableComment.body);
  });

  it('thumbs_up (accepted_pattern) round-trips into the prompt without suppressing the comment', async () => {
    const provider = makeProvider();
    const store = makeStore();

    const r1 = await runReview(baseJob, provider);
    const fp = r1.comments[0]?.fingerprint ?? '';
    expect(fp).toBeTruthy();

    const feedback = createFeedbackWriter({ writer: store.writer });
    await feedback.record({
      installationId: 4242n,
      repo: 'almondoo/review-agent',
      kind: 'thumbs_up',
      fingerprint: fp,
      factText: stableComment.body,
    });
    expect(store.rows[0]?.factType).toBe('accepted_pattern');

    const r2 = await runReview(baseJob, provider, {
      historyReader: async () => store.rows,
      evalContext: { installationId: 4242n, prNumber: 7, headSha: 'h' },
    });
    // accepted_pattern does NOT add the fingerprint to the rejected
    // set — the comment is still posted on subsequent reviews. The
    // operator's positive signal only informs the LLM's context.
    expect(r2.droppedByFeedback).toBe(0);
    expect(r2.comments).toHaveLength(1);
    const sysPrompt = (provider.generateReview as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
      ?.systemPrompt as string;
    expect(sysPrompt).toContain('<learned_facts>');
  });

  it('rate-limit overflow: the 11th feedback event is dropped (10/job default cap)', async () => {
    const store = makeStore();
    const feedback = createFeedbackWriter({ writer: store.writer });

    const events: Array<{ dropped: boolean }> = [];
    for (let i = 0; i < 12; i += 1) {
      // Distinct fingerprints so the writer doesn't dedup at insert.
      events.push(
        await feedback.record({
          installationId: 4242n,
          repo: 'almondoo/review-agent',
          kind: 'thumbs_down',
          fingerprint: fingerprint({
            path: 'src/x.ts',
            line: i + 1,
            ruleId: 'minor',
            suggestionType: 'comment',
          }),
          factText: `event ${i}`,
        }),
      );
    }

    // First 10 land; events 11 and 12 are dropped.
    expect(events.slice(0, 10).every((e) => !e.dropped)).toBe(true);
    expect(events[10]?.dropped).toBe(true);
    expect(events[11]?.dropped).toBe(true);
    expect(store.rows).toHaveLength(10);
  });
});
