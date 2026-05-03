// Static allowlist of GitHub logins for known PR review bots that
// review-agent will defer to when `coordination.other_bots:
// defer_if_present` is set (spec §22 #9 / v1.0 #48).
//
// Operators extend this set via `coordination.other_bots_logins:` in
// `.review-agent.yml`; they cannot remove built-in entries through
// config (the assumption being that an operator who explicitly opted
// into deference wants to defer to all known reviewers, not just a
// subset). Use the `ignore` mode if a given login should NOT trigger
// deference.
//
// Naming follows GitHub's `[bot]`-suffix convention for App actors.
// Plain user / PAT accounts (e.g. self-hosted reviewers) belong in
// the operator override list, not here.
export const KNOWN_REVIEW_BOT_LOGINS = [
  'coderabbitai[bot]',
  'qodo-merge[bot]',
  'pr-agent-bot[bot]',
  'bedrock-pr-reviewer[bot]',
] as const;

export type KnownReviewBotLogin = (typeof KNOWN_REVIEW_BOT_LOGINS)[number];

export function isKnownReviewBotLogin(login: string): login is KnownReviewBotLogin {
  return (KNOWN_REVIEW_BOT_LOGINS as ReadonlyArray<string>).includes(login);
}
