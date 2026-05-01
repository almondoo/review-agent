import { describe, expect, it } from 'vitest';
import {
  INJECTION_DETECTOR_OPT_OUT_ENV,
  resolveInjectionDetectorPolicy,
} from './injection-detector-policy.js';

describe('resolveInjectionDetectorPolicy', () => {
  it('defaults to enabled with no warning', () => {
    expect(resolveInjectionDetectorPolicy({})).toEqual({ enabled: true, warning: '' });
  });

  it('disables on REVIEW_AGENT_DISABLE_INJECTION_DETECTOR=1', () => {
    const result = resolveInjectionDetectorPolicy({
      [INJECTION_DETECTOR_OPT_OUT_ENV]: '1',
    });
    expect(result.enabled).toBe(false);
    expect(result.warning).toContain('disabled');
    expect(result.warning).toContain(INJECTION_DETECTOR_OPT_OUT_ENV);
  });

  it("also accepts 'true' (defensive parsing)", () => {
    const result = resolveInjectionDetectorPolicy({
      [INJECTION_DETECTOR_OPT_OUT_ENV]: 'true',
    });
    expect(result.enabled).toBe(false);
  });

  it('any other value keeps the detector enabled (fail-closed for unrecognised flags)', () => {
    expect(resolveInjectionDetectorPolicy({ [INJECTION_DETECTOR_OPT_OUT_ENV]: '0' }).enabled).toBe(
      true,
    );
    expect(
      resolveInjectionDetectorPolicy({ [INJECTION_DETECTOR_OPT_OUT_ENV]: 'false' }).enabled,
    ).toBe(true);
    expect(resolveInjectionDetectorPolicy({ [INJECTION_DETECTOR_OPT_OUT_ENV]: '' }).enabled).toBe(
      true,
    );
  });
});
