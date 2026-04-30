import type { Middleware } from '../types.js';

const SUSPICIOUS_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore previous instructions/i,
  /system prompt/i,
  /you are now/i,
  /respond only with/i,
];

export type InjectionGuardOptions = {
  readonly onSuspicion?: (reason: string) => void;
};

export function createInjectionGuard(opts: InjectionGuardOptions = {}): Middleware {
  return async (ctx, next) => {
    const { prMetadata } = ctx.job;
    const haystack = `${prMetadata.title}\n${prMetadata.body}`;
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(haystack)) {
        opts.onSuspicion?.(`pattern matched: ${pattern.source}`);
        break;
      }
    }
    return next();
  };
}
