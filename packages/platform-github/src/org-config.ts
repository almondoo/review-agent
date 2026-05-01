import { Buffer } from 'node:buffer';
import type { Octokit } from '@octokit/rest';
import type { OrgConfigFetch } from '@review-agent/config';

const ORG_CONFIG_REPO = '.github';
const ORG_CONFIG_PATH = 'review-agent.yml';

// Wires `OrgConfigFetch` to GitHub: looks for
// `<owner>/.github/review-agent.yml` and returns its contents (UTF-8).
// Returns `null` for any 404 — the `.github` repo or the file may
// legitimately be absent. All other errors propagate.
export type GithubOrgConfigDeps = {
  /** Reuse the per-installation Octokit so we ride the same App auth. */
  readonly octokit: Pick<Octokit, 'rest'>;
  /** Override the path / repo for testing or non-default conventions. */
  readonly repoName?: string;
  readonly filePath?: string;
};

export function createGithubOrgConfigFetch(deps: GithubOrgConfigDeps): OrgConfigFetch {
  const repoName = deps.repoName ?? ORG_CONFIG_REPO;
  const filePath = deps.filePath ?? ORG_CONFIG_PATH;

  return async (owner: string): Promise<string | null> => {
    try {
      const { data } = await deps.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: filePath,
      });
      // getContent returns either a file object, a directory listing,
      // a symlink, or a submodule. Only the file shape carries
      // `content`; everything else we treat as missing.
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }
      const encoding = data.encoding ?? 'base64';
      if (encoding !== 'base64') {
        // GitHub only ever returns base64 for repos.getContent today,
        // but fail loudly if that ever changes.
        throw new Error(`Unexpected ${repoName}/${filePath} encoding: ${encoding}`);
      }
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'status' in err &&
      (err as { status?: number }).status === 404,
  );
}
