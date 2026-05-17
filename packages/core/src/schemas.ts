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
import { extractUrls, isPrefixAllowed, isPrOwnRepoUrl } from './url.js';

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

/**
 * Inputs that {@link createReviewOutputSchema} bakes into its URL
 * allowlist refinement. Both fields are required so callers commit
 * to a closed-world policy: an empty `allowedUrlPrefixes` permits
 * only links into the PR's own repository (spec §7.3 #4).
 */
export type CreateReviewOutputSchemaOpts = {
  /**
   * Whitelisted URL prefixes from `.review-agent.yml`
   * `privacy.allowed_url_prefixes`. Matched with `startsWith` on
   * each extracted URL.
   */
  allowedUrlPrefixes: readonly string[];
  /**
   * The PR's own repository. Any URL whose host matches `host`
   * (case-insensitive) and whose path begins with `/<owner>/<repo>`
   * is implicitly allowed. The host is required (not inferred) so
   * GHES installations work without code changes — callers derive
   * it from `GITHUB_SERVER_URL` (Action) or the installation host
   * (webhook server).
   */
  prRepo: { host: string; owner: string; repo: string };
};

/**
 * Build a `ReviewOutputSchema` instance bound to a specific PR's
 * URL allowlist. The returned schema is the union of:
 *
 * - The base shape (`comments: InlineComment[]`, `summary: string`).
 * - The InlineComment-level refines (broadcast mentions, shell
 *   `curl http`, style-severity cap) which are unaware of allowlist
 *   context and therefore live on `InlineCommentSchema`.
 * - A factory-level `superRefine` that scans every comment `body`,
 *   every comment `suggestion`, and the `summary` for http(s) URLs
 *   and rejects any URL that isn't (a) under the PR's own repo or
 *   (b) prefixed by an entry in `allowedUrlPrefixes`. The
 *   `suggestion` field is scanned because GitHub's Apply-suggestion
 *   button copies its body verbatim into the repo — letting an
 *   LLM-emitted bad URL through `suggestion` would be a one-click
 *   path to persisting an exfiltration link in source. Each
 *   disallowed URL produces its own issue so callers see the full
 *   list, not just the first hit.
 *
 * Per spec §7.3 #4, this URL allowlist is the hard backstop against
 * the LLM exfiltrating PR content through prompt injection — keep
 * it factory-bound rather than module-global so the policy travels
 * with the request.
 */
export function createReviewOutputSchema(opts: CreateReviewOutputSchemaOpts) {
  const base = z
    .object({
      comments: z.array(InlineCommentSchema).max(COMMENTS_MAX),
      summary: z.string().min(1).max(SUMMARY_MAX),
    })
    .strict();
  // Snapshot policy inputs at construction time. Callers reuse a
  // schema across multiple parses for one PR, so we materialize a
  // mutable array (the helper signature expects `string[]`) and
  // pull `owner` / `repo` out of the options object once.
  const allowedPrefixes = [...opts.allowedUrlPrefixes];
  const prRepo = opts.prRepo;
  return base.superRefine((output, ctx) => {
    const reportBadUrls = (text: string, path: (string | number)[]) => {
      for (const url of extractUrls(text)) {
        if (isPrOwnRepoUrl(url, prRepo)) continue;
        if (isPrefixAllowed(url, allowedPrefixes)) continue;
        // The error message includes the expected `host` and a hint
        // so operators looking at a failed Zod parse can immediately
        // see (a) which URL was rejected and (b) the PR's host they
        // should compare it against. `<owner>/<repo>` is omitted from
        // the hint because the path was already encoded in the URL
        // the operator is reading.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `URL not in allowlist: ${url} (expected host '${prRepo.host}' or a configured allowed_url_prefixes entry)`,
          path,
        });
      }
    };
    output.comments.forEach((comment, i) => {
      reportBadUrls(comment.body, ['comments', i, 'body']);
      // `suggestion` is optional on InlineCommentSchema, so guard the
      // scan. When present, the field is scanned identically to body
      // (see overview JSDoc for why suggestion needs the same check).
      if (comment.suggestion !== undefined) {
        reportBadUrls(comment.suggestion, ['comments', i, 'suggestion']);
      }
    });
    reportBadUrls(output.summary, ['summary']);
  });
}

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
// `superRefine` doesn't change the input shape, so the input type is
// stable across any `opts` choice. Tying it to the factory return
// type means callers never need to track the inner ZodObject by hand.
export type ReviewOutputInput = z.input<ReturnType<typeof createReviewOutputSchema>>;
export type ReviewStateInput = z.input<typeof ReviewStateSchema>;
