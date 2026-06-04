export { type AppDeps, createApp } from './app.js';
export {
  type CodecommitWebhookDeps,
  type CodecommitWebhookResult,
  handleCodecommitWebhook,
} from './handlers/codecommit-webhook.js';
export {
  type ConversationHandlerInput,
  type ConversationReplyOutcome,
  type FeedbackCommandOutcome,
  handleWebhook,
  recordFeedbackCommandOutcome,
  type WebhookHandlerDeps,
  type WebhookResult,
} from './handlers/webhook.js';
export { createSqsLambdaHandler, type LambdaWorkerOpts } from './lambda-worker.js';
export {
  _resetMetricsForTest,
  bridgeEvalRecordErrorsToMetrics,
  bridgeFeedbackRateLimitToMetrics,
  bridgeHistoryReaderErrorsToMetrics,
  bridgePrunedRowsToMetrics,
  bridgeSuppressionRulesCreatedToMetrics,
  getMetrics,
  type ReviewAgentMetrics,
} from './metrics.js';
export { type IdempotencyDeps, idempotency } from './middleware/idempotency.js';
export { type VerifyEnv, verifyGithubSignature } from './middleware/verify-signature.js';
export {
  BODY_ATTR_KEYS,
  BodyRedactionProcessor,
  type OtelEnv,
  parseOtlpHeaders,
  type StartTelemetryOpts,
  startTelemetry,
  type TelemetryHandle,
} from './otel.js';
export { createSqsQueueClient, type SqsQueueOpts } from './queue/sqs.js';
export { type SpanAttributes, type SpanName, withSpan } from './spans.js';
export {
  type CodeCommitAuthzInput,
  type CollaboratorPermissionGetter,
  checkCodeCommitFeedbackAuthz,
  checkGithubFeedbackAuthz,
  type FeedbackAuthzResult,
  type GithubAuthzInput,
} from './utils/feedback-authz.js';
export {
  FEEDBACK_COMMAND_PREFIX,
  type FeedbackCommand,
  type FeedbackCommandKind,
  parseFeedbackCommand,
} from './utils/parse-command.js';
export {
  type CleanupHandle,
  type JobHandler,
  type ReviewHistoryCleanupDeps,
  startIdempotencyCleanup,
  startReviewHistoryCleanup,
  startWorker,
  type WorkerDeps,
} from './worker.js';
export {
  type ProvisionWorkspaceDeps,
  type ProvisionWorkspaceInput,
  provisionWorkspace,
  type WorkspaceHandle,
  type WorkspaceStrategy,
} from './workspace.js';
