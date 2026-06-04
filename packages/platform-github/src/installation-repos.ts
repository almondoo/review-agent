import type { Octokit } from '@octokit/rest';

export type InstallationRepo = {
  readonly id: number;
  readonly fullName: string;
  readonly private: boolean;
};

export async function listInstallationRepos(
  octokit: Pick<Octokit, 'paginate' | 'apps'>,
  installationId: bigint | number,
): Promise<InstallationRepo[]> {
  const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, {
    installation_id: Number(installationId),
    per_page: 100,
  });
  return repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    private: r.private,
  }));
}
