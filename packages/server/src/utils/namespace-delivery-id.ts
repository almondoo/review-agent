/**
 * Namespace prefix for the shared `webhook_deliveries.delivery_id` column.
 *
 * GitHub `X-GitHub-Delivery` is a server-issued UUID, and SNS `MessageId`
 * is likewise a UUID. They live in distinct ID spaces, but a probabilistic
 * UUID collision between the two would dedup the wrong delivery if both
 * platforms wrote raw IDs into the same column.
 *
 * Per the SEC-3 audit finding, the CodeCommit bridge prefixes every SNS
 * `MessageId` with `sns:` before exposing it to the shared idempotency
 * middleware. GitHub deliveries continue to write the bare `delivery_id`
 * for backwards compatibility with existing rows — the namespace is one-
 * sided, asymmetric by design (see `docs/deployment/aws.md` and the
 * `app.ts` bridge for details).
 */
export type DeliveryPlatform = 'github' | 'codecommit';

const PLATFORM_PREFIX: Readonly<Record<DeliveryPlatform, string>> = {
  github: 'gh:',
  codecommit: 'sns:',
};

export function namespaceDeliveryId(platform: DeliveryPlatform, id: string): string {
  return `${PLATFORM_PREFIX[platform]}${id}`;
}
