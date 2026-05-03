// Multi-bot coordination policy (spec §22 #9 / v1.0 #48).
//
// `decideCoordination` is a pure function: it takes the operator's
// `coordination.*` configuration plus the PR's existing comment
// authors, and returns whether this run should defer to another
// review bot. The action / server / CLI wrappers are responsible for
// (a) gathering the comment authors via the VCS adapter and (b)
// posting the skip-summary comment when `defer` is true.
//
// `runner` deliberately doesn't import from `@review-agent/config` —
// the static allowlist lives there (it's operator-facing); the
// caller passes the union of the built-in list and any operator
// override (`coordination.other_bots_logins`) in via `botLogins`.
// Match is on exact GitHub login (the `[bot]`-suffix is included)
// because partial matches risk false positives against human
// reviewers and the platform adapter normalises to `c.user.login`.

export const COORDINATION_MODES = ['ignore', 'defer_if_present'] as const;
export type CoordinationMode = (typeof COORDINATION_MODES)[number];

export type CoordinationDecisionInput = {
  readonly mode: CoordinationMode;
  readonly botLogins: ReadonlyArray<string>;
  readonly existingCommentAuthors: ReadonlyArray<string>;
};

export type CoordinationDecision =
  | { readonly action: 'proceed' }
  | { readonly action: 'defer'; readonly bot: string };

export function decideCoordination(input: CoordinationDecisionInput): CoordinationDecision {
  if (input.mode === 'ignore') return { action: 'proceed' };
  const detection = new Set(input.botLogins);
  for (const author of input.existingCommentAuthors) {
    if (detection.has(author)) return { action: 'defer', bot: author };
  }
  return { action: 'proceed' };
}

// Body for the single skip-summary comment posted when deferring.
// Markdown formatted; the action wrapper passes this to
// `vcs.postSummary(...)`. Kept here so the message stays close to
// the policy code that produces it.
export function renderDeferralSummary(bot: string): string {
  return [
    '### review-agent — skipped',
    '',
    `Detected an existing review by \`${bot}\`. \`coordination.other_bots\` is set to \`defer_if_present\`, so this run will not post additional comments.`,
    '',
    'To override, set `coordination.other_bots: ignore` in `.review-agent.yml` (or remove the key entirely — `ignore` is the default).',
  ].join('\n');
}
