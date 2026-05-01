// Policy resolver for the LLM-based injection detector. v0.3 default
// is **mandatory** (spec §22 OQ #14 resolution). Operators can opt
// out for cost-sensitive deployments via the env var
// `REVIEW_AGENT_DISABLE_INJECTION_DETECTOR=1`. The opt-out is
// designed to be loud — `resolveInjectionDetectorPolicy` returns a
// `warning` string that the worker glue logs on every cold start.

export type InjectionDetectorPolicy = {
  readonly enabled: boolean;
  /**
   * Operator-facing string the worker should log at boot. Empty when
   * the detector is in its default (enabled) state.
   */
  readonly warning: string;
};

export const INJECTION_DETECTOR_OPT_OUT_ENV = 'REVIEW_AGENT_DISABLE_INJECTION_DETECTOR';

export function resolveInjectionDetectorPolicy(
  env: Pick<NodeJS.ProcessEnv, typeof INJECTION_DETECTOR_OPT_OUT_ENV>,
): InjectionDetectorPolicy {
  const value = env[INJECTION_DETECTOR_OPT_OUT_ENV];
  if (value === '1' || value === 'true') {
    return {
      enabled: false,
      warning:
        `WARNING: ${INJECTION_DETECTOR_OPT_OUT_ENV}=1 is set. ` +
        'The LLM-based injection detector (spec §7.3 #3) is disabled. ' +
        'Pattern-based heuristics still run, but sophisticated prompt ' +
        'injection in PR bodies / commit messages / file content WILL ' +
        'reach the main review LLM. Re-enable in production by unsetting ' +
        'this env var.',
    };
  }
  return { enabled: true, warning: '' };
}
