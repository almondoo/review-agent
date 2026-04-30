import { handle } from 'hono/aws-lambda';
import { type AppDeps, createApp } from './app.js';

export function createLambdaHandler(deps: AppDeps): ReturnType<typeof handle> {
  return handle(createApp(deps));
}
