import { serve } from '@hono/node-server';
import { type AppDeps, createApp } from './app.js';

export type NodeServerOptions = AppDeps & {
  readonly port?: number;
  readonly hostname?: string;
};

export function startNodeServer(opts: NodeServerOptions): ReturnType<typeof serve> {
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const fetch = createApp(opts).fetch;
  const serveOpts: Parameters<typeof serve>[0] = { fetch, port };
  if (opts.hostname) (serveOpts as { hostname?: string }).hostname = opts.hostname;
  return serve(serveOpts);
}
