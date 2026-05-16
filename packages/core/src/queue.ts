import { z } from 'zod';

// `prRef` is a discriminated union on `platform`. The two members enforce
// opposite owner constraints because the two platforms model tenancy
// differently:
//
// - **GitHub** identifies a repo by `<owner>/<repo>`. `owner` MUST be a
//   non-empty string; otherwise the clone URL collapses to
//   `https://x-access-token:${token}@github.com//${repo}.git` (a double
//   slash followed by repo), which an attacker forging a JobMessage can
//   use to coax git into a misleading error path that leaks the token in
//   stderr/log scrubs. The strict `min(1)` here is the first line of
//   defense; `defaultCloneUrl` in `platform-github` adds a second.
//
// - **CodeCommit** has no `owner` concept at all — only a flat repo name
//   inside an AWS account. The account/region tenancy lives in the
//   SNS-derived `installationId` and DB row, not the PR ref. `owner` MUST
//   be the empty string so that the GitHub<->CodeCommit `stateId`
//   namespace (`${owner}/${repo}#${number}`) cannot collide with a real
//   GitHub `<owner>/<repo>#N` triple.
const GithubRefSchema = z.object({
  platform: z.literal('github'),
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  number: z.number().int().positive(),
  headSha: z.string().min(7).max(64).optional(),
});

const CodecommitRefSchema = z.object({
  platform: z.literal('codecommit'),
  owner: z.literal(''),
  repo: z.string().min(1).max(200),
  number: z.number().int().positive(),
  headSha: z.string().min(7).max(64).optional(),
});

const PrRefSchema = z.discriminatedUnion('platform', [GithubRefSchema, CodecommitRefSchema]);

export const JobMessageSchema = z.object({
  jobId: z.string().min(1).max(128),
  installationId: z.string().min(1).max(64),
  prRef: PrRefSchema,
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
