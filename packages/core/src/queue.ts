import { z } from 'zod';

export const JobMessageSchema = z.object({
  jobId: z.string().min(1).max(128),
  installationId: z.string().min(1).max(64),
  prRef: z.object({
    // Widening from `z.literal('github')` to a two-value enum is back-compat:
    // existing queued/persisted rows with `platform: 'github'` still parse
    // against the wider schema unchanged, while new CodeCommit jobs (issue
    // #73 follow-on) can now mint `platform: 'codecommit'` without the
    // receiver casting through `unknown`. `owner` also loses its `min(1)`
    // floor because CodeCommit has no notion of an account/org owner — only
    // a flat repository name — so the receiver mints `owner: ''` for
    // codecommit jobs. GitHub jobs continue to pass non-empty `owner`.
    platform: z.enum(['github', 'codecommit']),
    owner: z.string().max(200),
    repo: z.string().min(1).max(200),
    number: z.number().int().positive(),
    headSha: z.string().min(7).max(64).optional(),
  }),
  triggeredBy: z.enum([
    'pull_request.opened',
    'pull_request.synchronize',
    'pull_request.reopened',
    'pull_request.ready_for_review',
    'comment.command',
    'manual',
  ]),
  enqueuedAt: z.string().datetime(),
});

export type JobMessage = z.infer<typeof JobMessageSchema>;

export type QueueClient = {
  enqueue(message: JobMessage): Promise<{ messageId: string }>;
  dequeue(handler: (m: JobMessage) => Promise<void>, opts?: DequeueOpts): Promise<void>;
};

export type DequeueOpts = {
  readonly waitTimeSeconds?: number;
  readonly maxMessages?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly stopSignal?: AbortSignal;
};
