export {
  CODECOMMIT_CAPABILITIES,
  type CodeCommitClientLike,
  type CodeCommitRawComment,
  type CodeCommitVCSOptions,
  createCodecommitVCS,
  createDefaultCodeCommitClient,
  listCodeCommitCommentsForPullRequest,
  listCodeCommitPullRequestIds,
} from './adapter.js';
export {
  CODECOMMIT_PLATFORM_ID,
  codecommitPlatform,
} from './platform.js';
