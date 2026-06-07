/**
 * Notification module types (#144).
 *
 * Payloads contain metadata only — no source code, diffs, or PII.
 * The `summary` field is a plain-text human-readable count/status line
 * (e.g. "3 findings: 1 critical, 2 minor") — never raw LLM output.
 */

export type NotificationEventType = 'job.failed' | 'budget.overrun' | 'review.completed';

export type NotificationEvent = {
  /** The event kind that triggered this notification. */
  readonly type: NotificationEventType;
  /** "owner/repo" slug — no PII. */
  readonly repo: string;
  /** GitHub App installation ID (numeric string). */
  readonly installationId: string;
  /** Unique job identifier used for deduplication. */
  readonly jobId: string;
  /** ISO-8601 timestamp of the event. */
  readonly timestamp: string;
  /** PR number, if the event is tied to a specific pull request. */
  readonly prNumber?: number | undefined;
  /**
   * Human-readable summary of the event outcome.
   * Metadata only — counts/labels, no code or diff content.
   * Examples: "Review completed: 4 findings", "Job failed: cost cap exceeded".
   */
  readonly summary: string;
};

/**
 * A pluggable notification channel. Each implementation (Slack, SMTP, SES)
 * is constructed via a factory function with DI hooks for testability.
 *
 * `send` must be fail-open — callers (the dispatcher) catch errors.
 */
export interface NotificationChannel {
  readonly name: string;
  send(event: NotificationEvent): Promise<void>;
}
