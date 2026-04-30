import { type JobMessage, JobMessageSchema } from '@review-agent/core';
import type { JobHandler } from './worker.js';

type SQSRecord = {
  messageId: string;
  body: string;
  receiptHandle: string;
};

type SQSEvent = {
  Records: ReadonlyArray<SQSRecord>;
};

type SQSBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export type LambdaWorkerOpts = {
  readonly handler: JobHandler;
};

export function createSqsLambdaHandler(
  opts: LambdaWorkerOpts,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent) => {
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      let parsed: JobMessage;
      try {
        parsed = JobMessageSchema.parse(JSON.parse(record.body));
      } catch {
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        await opts.handler(parsed);
      } catch {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
