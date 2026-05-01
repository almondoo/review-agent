import { describe, expect, it, vi } from 'vitest';
import { createCostKillSwitch } from './cost-kill-switch.js';

describe('createCostKillSwitch', () => {
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
});
