import { z } from 'zod';

export const JobMessageSchema = z.object({
  jobId: z.string().min(1).max(128),
  installationId: z.string().min(1).max(64),
  prRef: z.object({
    platform: z.literal('github'),
    owner: z.string().min(1).max(200),
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
