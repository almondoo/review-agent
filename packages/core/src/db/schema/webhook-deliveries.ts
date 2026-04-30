import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const webhookDeliveryStatuses = ['received', 'enqueued', 'duplicate', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull().$type<WebhookDeliveryStatus>(),
  },
  (t) => [index('webhook_deliveries_received_at_idx').on(t.receivedAt)],
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
