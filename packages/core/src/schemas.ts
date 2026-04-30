import { z } from 'zod';
import { SEVERITIES, SIDES } from './review.js';

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4000;
const MAX_SUGGESTION_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 8000;
const MAX_CATEGORY_LENGTH = 64;
const MAX_PATH_LENGTH = 1024;

const BROADCAST_MENTION = /@(everyone|channel|here)\b/i;
const SHELL_HTTP_FETCH = /\b(curl|wget)\s+[^\s|]*?https?:\/\//i;

function notBroadcastMention(text: string): boolean {
  return !BROADCAST_MENTION.test(text);
}

function notShellHttpFetch(text: string): boolean {
  return !SHELL_HTTP_FETCH.test(text);
}

const safeText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(notBroadcastMention, {
      message: 'Broadcast mentions (@everyone, @channel, @here) are not allowed.',
    })
    .refine(notShellHttpFetch, {
      message: 'Shell commands fetching remote URLs (curl/wget http) are not allowed.',
    });

export const InlineCommentSchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    line: z.number().int().positive(),
    side: z.enum(SIDES),
    severity: z.enum(SEVERITIES),
    title: safeText(1, MAX_TITLE_LENGTH),
    body: safeText(1, MAX_BODY_LENGTH),
    suggestion: safeText(0, MAX_SUGGESTION_LENGTH).nullable(),
    category: z.string().min(1).max(MAX_CATEGORY_LENGTH),
  })
  .strict();

export const ReviewOutputSchema = z
  .object({
    summary: safeText(1, MAX_SUMMARY_LENGTH),
    comments: z.array(InlineCommentSchema).max(100),
  })
  .strict();

export type InlineCommentInput = z.input<typeof InlineCommentSchema>;
export type ReviewOutputInput = z.input<typeof ReviewOutputSchema>;
