import { z } from 'zod';
import {
  BODY_MAX,
  COMMENTS_MAX,
  LINE_MAX,
  MODEL_NAME_MAX,
  MODEL_NAME_MIN,
  PATH_MAX,
  RULE_ID_MAX,
  RULE_ID_MIN,
  SUGGESTION_MAX,
  SUMMARY_MAX,
} from './limits.js';
import { CATEGORIES, CONFIDENCES, SEVERITIES, SIDES } from './review.js';

const NO_NUL = /^[^\0]+$/;
const SHELL_HTTP_FETCH = /\bcurl\s+http/i;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const FINGERPRINT_HEX = /^[0-9a-f]{16}$/;
const RULE_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

export const REVIEW_STATE_SCHEMA_VERSION = 1;

function notBroadcastMention(text: string): boolean {
  return !text.includes('@everyone') && !text.includes('@channel');
}

function notShellHttpFetch(text: string): boolean {
  return !SHELL_HTTP_FETCH.test(text);
}

const safeBody = z
  .string()
  .min(1)
  .max(BODY_MAX)
  .refine(notBroadcastMention, {
    message: 'must not include broadcast mentions',
  })
  .refine(notShellHttpFetch, {
    message: 'must not include shell commands',
  });

export const InlineCommentSchema = z
  .object({
    path: z.string().min(1).max(PATH_MAX).regex(NO_NUL),
    line: z.number().int().positive().max(LINE_MAX),
    side: z.enum(SIDES),
    body: safeBody,
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    ruleId: z.string().min(RULE_ID_MIN).max(RULE_ID_MAX).regex(RULE_ID_PATTERN).optional(),
    suggestion: z.string().max(SUGGESTION_MAX).optional(),
  })
  .strict()
  // Enforce the taxonomy rule that `style` findings never exceed
  // `minor`. The system prompt also instructs the LLM not to emit
  // `style/major|critical`, but the schema is the hard backstop —
  // a provider that ignores the prompt still cannot escalate style.
  .refine(
    (c) => !(c.category === 'style' && (c.severity === 'major' || c.severity === 'critical')),
    {
      message: "category='style' must be at most severity='minor'",
      path: ['severity'],
    },
  );

export const ReviewOutputSchema = z
  .object({
    comments: z.array(InlineCommentSchema).max(COMMENTS_MAX),
    summary: z.string().min(1).max(SUMMARY_MAX),
  })
  .strict();

export const ReviewStateSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_STATE_SCHEMA_VERSION),
    lastReviewedSha: z.string().regex(SHA1_HEX),
    baseSha: z.string().regex(SHA1_HEX),
    reviewedAt: z.string().datetime(),
    modelUsed: z.string().min(MODEL_NAME_MIN).max(MODEL_NAME_MAX),
    totalTokens: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    commentFingerprints: z.array(z.string().regex(FINGERPRINT_HEX)),
  })
  .strict();

export type InlineCommentInput = z.input<typeof InlineCommentSchema>;
export type ReviewOutputInput = z.input<typeof ReviewOutputSchema>;
export type ReviewStateInput = z.input<typeof ReviewStateSchema>;
