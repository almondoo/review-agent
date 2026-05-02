import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCostKillSwitch } from './cost-kill-switch.js';

describe('createCostKillSwitch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('terminates only on the kill threshold', () => {
    const terminate = vi.fn();
    const handler = createCostKillSwitch({ terminate });
    handler({ threshold: 'fallback', cumulativeUsd: 0, capUsd: 1 });
    handler({ threshold: 'abort', cumulativeUsd: 1, capUsd: 1 });
    handler({ threshold: 'daily_cap', cumulativeUsd: 5, capUsd: 5 });
    expect(terminate).not.toHaveBeenCalled();
    handler({ threshold: 'kill', cumulativeUsd: 1.6, capUsd: 1 });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back to process.kill(pid, SIGTERM) when terminate is omitted', () => {
    // Ensure the production default actually fires SIGTERM at our own pid.
    // We spy on process.kill so the test process does not actually die.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const handler = createCostKillSwitch();
    handler({ threshold: 'kill', cumulativeUsd: 1.6, capUsd: 1 });
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });
});
