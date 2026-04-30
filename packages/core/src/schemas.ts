import { z } from 'zod';
import { SEVERITIES, SIDES } from './review.js';

const PATH_MAX = 500;
const BODY_MAX = 5000;
const SUGGESTION_MAX = 5000;
const SUMMARY_MAX = 10_000;
const LINE_MAX = 1_000_000;
const COMMENTS_MAX = 50;

const NO_NUL = /^[^\0]+$/;
const SHELL_HTTP_FETCH = /\bcurl\s+http/i;

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
    suggestion: z.string().max(SUGGESTION_MAX).optional(),
  })
  .strict();

export const ReviewOutputSchema = z
  .object({
    comments: z.array(InlineCommentSchema).max(COMMENTS_MAX),
    summary: z.string().min(1).max(SUMMARY_MAX),
  })
  .strict();

export type InlineCommentInput = z.input<typeof InlineCommentSchema>;
export type ReviewOutputInput = z.input<typeof ReviewOutputSchema>;
