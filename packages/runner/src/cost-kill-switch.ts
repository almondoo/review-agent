import type { CostThresholdEvent } from './middleware/cost-guard.js';

export type KillSwitchOpts = {
  /**
   * Replaceable for tests. Defaults to `process.kill(process.pid, 'SIGTERM')`
   * so the surrounding worker drains gracefully — the SQS visibility
   * timeout will redeliver the in-flight job to a fresh worker.
   */
  readonly terminate?: () => void;
};

// Builds a threshold-crossed handler that fires a SIGTERM at the
// 150% kill threshold (spec §6.2). At fallback / abort it does
// nothing — caller composes additional handlers (audit log, OTel)
// alongside this one.
//
// The kill is intentionally paranoid: §6.2 documents up to ±20%
// drift between estimated and actual cost, so cumulative > 1.5×
// cap means estimation drift alone cannot explain the overrun and
// the safest move is to drop the worker.
export function createCostKillSwitch(
  opts: KillSwitchOpts = {},
): (event: CostThresholdEvent) => void {
  const terminate = opts.terminate ?? defaultTerminate;
  return (event) => {
    if (event.threshold !== 'kill') return;
    terminate();
  };
}

function defaultTerminate(): void {
  // Send SIGTERM to ourselves; the worker's signal handler should
  // drain in-flight work and exit. If no signal handler is wired,
  // Node exits with code 143 by default — also acceptable.
  process.kill(process.pid, 'SIGTERM');
}
