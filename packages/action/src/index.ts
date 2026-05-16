import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs } from './inputs.js';
import { runAction } from './run.js';

async function main(): Promise<void> {
  try {
    const inputs = parseInputs({
      'github-token': core.getInput('github-token'),
      'anthropic-api-key': core.getInput('anthropic-api-key'),
      language: core.getInput('language'),
      'config-path': core.getInput('config-path'),
      'cost-cap-usd': core.getInput('cost-cap-usd'),
      'state-write-retries': core.getInput('state-write-retries'),
    });

    const ctx = github.context;
    const pr = ctx.payload.pull_request;
    if (!pr || !ctx.repo) {
      core.warning('No pull_request payload; review-agent only runs on pull_request events.');
      return;
    }

    const result = await runAction(inputs, {
      ref: {
        platform: 'github',
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        number: pr.number,
      },
    });

    if (result.skipped) {
      core.info(`Skipped: ${result.skipReason ?? 'unknown reason'}`);
      core.setOutput('posted-comments', 0);
      core.setOutput('cost-usd', 0);
      return;
    }

    core.setOutput('posted-comments', result.postedComments);
    core.setOutput('cost-usd', result.costUsd.toFixed(4));
    core.info(`Posted ${result.postedComments} comments. Cost: $${result.costUsd.toFixed(4)}.`);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

export { type ActionInputs, parseInputs, type RawInputs } from './inputs.js';
export { runAction } from './run.js';

if (
  process.env.REVIEW_AGENT_ACTION_RUN === '1' ||
  import.meta.url === `file://${process.argv[1]}`
) {
  void main();
}
