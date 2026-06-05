export {
  type CreateNotificationDispatcherOpts,
  createNotificationDispatcher,
  type DispatcherLogger,
  type NotificationDispatcher,
} from './dispatcher.js';
export { type BuildNotificationChannelsEnv, buildNotificationChannels } from './factory.js';
export { createSesChannel, type SesChannelOpts } from './ses-channel.js';
export { createSlackChannel, type SlackChannelOpts } from './slack-channel.js';
export { createSmtpChannel, type SmtpChannelOpts } from './smtp-channel.js';
export type { NotificationChannel, NotificationEvent, NotificationEventType } from './types.js';
