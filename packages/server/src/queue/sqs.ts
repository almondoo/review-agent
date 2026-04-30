import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type DequeueOpts,
  type JobMessage,
  JobMessageSchema,
  type QueueClient,
} from '@review-agent/core';

export type SqsQueueOpts = {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly region?: string;
};

export function createSqsQueueClient(opts: SqsQueueOpts): QueueClient {
  const client = opts.client ?? new SQSClient(opts.region ? { region: opts.region } : {});

  async function enqueue(message: JobMessage): Promise<{ messageId: string }> {
    JobMessageSchema.parse(message);
    const out = await client.send(
      new SendMessageCommand({
        QueueUrl: opts.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          installationId: { DataType: 'String', StringValue: message.installationId },
          triggeredBy: { DataType: 'String', StringValue: message.triggeredBy },
        },
      }),
    );
    return { messageId: out.MessageId ?? '' };
  }

  async function dequeue(
    handler: (m: JobMessage) => Promise<void>,
    o: DequeueOpts = {},
  ): Promise<void> {
    const waitTime = o.waitTimeSeconds ?? 20;
    const maxMessages = o.maxMessages ?? 1;
    const visibility = o.visibilityTimeoutSeconds ?? 60;
    while (!o.stopSignal?.aborted) {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: opts.queueUrl,
          WaitTimeSeconds: waitTime,
          MaxNumberOfMessages: maxMessages,
          VisibilityTimeout: visibility,
        }),
      );
      const messages = out.Messages ?? [];
      for (const m of messages) {
        if (o.stopSignal?.aborted) return;
        if (!m.Body || !m.ReceiptHandle) continue;
        const parsed = parseBody(m.Body);
        if (!parsed) {
          // Malformed body — let visibility timeout return it to the queue,
          // and after maxReceiveCount it lands in the DLQ.
          continue;
        }
        try {
          await handler(parsed);
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: opts.queueUrl,
              ReceiptHandle: m.ReceiptHandle,
            }),
          );
        } catch (err) {
          // Re-throw is wrong here: leaves the consumer hot-looping. Let
          // visibility timeout roll over to the next receiver / DLQ path.
          /* v8 ignore next -- error path observed in integration tests */
          await onHandlerFailure(err, parsed);
        }
      }
    }
  }

  return { enqueue, dequeue };
}

function parseBody(body: string): JobMessage | null {
  try {
    return JobMessageSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }
}

/* v8 ignore start -- emits a structured log; observability test in v0.2 #20 */
async function onHandlerFailure(_err: unknown, _msg: JobMessage): Promise<void> {
  // Intentionally swallow: SQS visibility timeout governs retry & DLQ
  // routing. We just log structured fields here once OTel ships in v0.2 #20.
}
/* v8 ignore stop */
