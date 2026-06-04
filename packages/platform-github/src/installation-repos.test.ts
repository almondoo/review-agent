import { describe, expect, it, vi } from 'vitest';
import { listInstallationRepos } from './installation-repos.js';

function makeRepo(id: number, fullName: string, isPrivate: boolean) {
  return {
    id,
    full_name: fullName,
    private: isPrivate,
    // Minimal shape — paginate resolves to the flattened array items
    name: fullName.split('/')[1] ?? fullName,
    node_id: `MDEwOlJlcG9zaXRvcnk${id}`,
    owner: {
      login: fullName.split('/')[0] ?? 'owner',
      id: 1,
      node_id: 'MDQ6VXNlcjE=',
      avatar_url: '',
      gravatar_id: null,
      url: '',
      html_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      starred_url: '',
      subscriptions_url: '',
      organizations_url: '',
      repos_url: '',
      events_url: '',
      received_events_url: '',
      type: 'User',
      site_admin: false,
    },
    html_url: `https://github.com/${fullName}`,
    description: null,
    fork: false,
    url: `https://api.github.com/repos/${fullName}`,
    forks_url: '',
    keys_url: '',
    collaborators_url: '',
    teams_url: '',
    hooks_url: '',
    issue_events_url: '',
    events_url: '',
    assignees_url: '',
    branches_url: '',
    tags_url: '',
    blobs_url: '',
    git_tags_url: '',
    git_refs_url: '',
    trees_url: '',
    statuses_url: '',
    languages_url: '',
    stargazers_url: '',
    contributors_url: '',
    subscribers_url: '',
    subscription_url: '',
    commits_url: '',
    git_commits_url: '',
    comments_url: '',
    issue_comment_url: '',
    contents_url: '',
    compare_url: '',
    merges_url: '',
    archive_url: '',
    downloads_url: '',
    issues_url: '',
    pulls_url: '',
    milestones_url: '',
    notifications_url: '',
    labels_url: '',
    releases_url: '',
    deployments_url: '',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-01-01T00:00:00Z',
    git_url: '',
    ssh_url: '',
    clone_url: '',
    svn_url: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: 'main',
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  } as const;
}

describe('listInstallationRepos', () => {
  it('returns mapped repos from a single page', async () => {
    const page1 = [makeRepo(1, 'acme/alpha', false), makeRepo(2, 'acme/beta', true)];
    const paginate = vi.fn().mockResolvedValue(page1);
    const octokit = {
      paginate,
      apps: { listReposAccessibleToInstallation: vi.fn() },
    };

    const result = await listInstallationRepos(
      octokit as Parameters<typeof listInstallationRepos>[0],
      42,
    );

    expect(paginate).toHaveBeenCalledWith(octokit.apps.listReposAccessibleToInstallation, {
      installation_id: 42,
      per_page: 100,
    });
    expect(result).toEqual([
      { id: 1, fullName: 'acme/alpha', private: false },
      { id: 2, fullName: 'acme/beta', private: true },
    ]);
  });

  it('handles multiple pages by returning all repos', async () => {
    const page1 = [makeRepo(10, 'org/repo-a', false), makeRepo(11, 'org/repo-b', false)];
    const page2 = [makeRepo(20, 'org/repo-c', true)];
    // octokit.paginate auto-iterates pages and returns a flat array
    const paginate = vi.fn().mockResolvedValue([...page1, ...page2]);
    const octokit = {
      paginate,
      apps: { listReposAccessibleToInstallation: vi.fn() },
    };

    const result = await listInstallationRepos(
      octokit as Parameters<typeof listInstallationRepos>[0],
      99n,
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 10, fullName: 'org/repo-a', private: false });
    expect(result[2]).toEqual({ id: 20, fullName: 'org/repo-c', private: true });
  });

  it('accepts bigint installationId and converts to number for octokit', async () => {
    const paginate = vi.fn().mockResolvedValue([makeRepo(5, 'x/y', false)]);
    const octokit = {
      paginate,
      apps: { listReposAccessibleToInstallation: vi.fn() },
    };

    await listInstallationRepos(
      octokit as Parameters<typeof listInstallationRepos>[0],
      9999999999n,
    );

    expect(paginate).toHaveBeenCalledWith(
      octokit.apps.listReposAccessibleToInstallation,
      expect.objectContaining({ installation_id: 9999999999 }),
    );
  });

  it('returns an empty array when no repos are accessible', async () => {
    const paginate = vi.fn().mockResolvedValue([]);
    const octokit = {
      paginate,
      apps: { listReposAccessibleToInstallation: vi.fn() },
    };

    const result = await listInstallationRepos(
      octokit as Parameters<typeof listInstallationRepos>[0],
      1n,
    );

    expect(result).toEqual([]);
  });
});
