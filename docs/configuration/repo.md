# `repo.{submodules,lfs}` — clone hints

`repo.submodules` and `repo.lfs` control how the **Server-mode** worker
clones the target repository before running the review pipeline. They
have no effect in **Action mode** (where GitHub's own
`actions/checkout` runs first and produces the working tree) or in
**CLI mode** (which reviews the current checkout in place).

Spec reference: §9.3 (Repository Clone Strategy — Submodules / LFS),
§10 (`.review-agent.yml` schema).

## TL;DR

```yaml
repo:
  # Default: false. When true, the Server-mode clone runs
  # `--recurse-submodules --shallow-submodules` so nested repos are
  # materialized along with the parent. Off by default because nested
  # repos add clone cost and may carry credentials the parent
  # installation should not be able to read.
  submodules: false

  # Default: false. When false (the default), every git invocation
  # during clone runs with `GIT_LFS_SKIP_SMUDGE=1` so LFS-tracked
  # files arrive as pointer text rather than being smudge-fetched.
  # Set to true to opt in to full LFS smudge — most reviews do not
  # benefit because spec §9.3 already excludes binary file types
  # (`*.bin`, `*.parquet`, `*.pdf`, `*.png`, `*.jpg`, `*.mp4`,
  # `*.zip`) from the review payload regardless of this flag.
  lfs: false
```

## Distribution-mode behavior

| Mode | Clones in-process? | `repo.submodules` / `repo.lfs` effect |
|---|---|---|
| **Action** (`packages/action`) | No (actions/checkout runs first) | Ignored |
| **CLI** (`packages/cli`) | No (reads existing checkout) | Ignored |
| **Server** (`packages/server`) | Yes (via `provisionWorkspace`) | Honored when `workspace_strategy: 'sparse-clone'` |

The Server-mode worker forwards the two flags to
`provisionWorkspace` via `ProvisionWorkspaceInput.cloneHints`, which
sets `CloneOpts.submodules` / `CloneOpts.lfs` on the VCS adapter call
(`cloneRepo`). The platform-github adapter then:

1. Adds `--recurse-submodules --shallow-submodules` to the initial
   `git clone` when `submodules: true`.
2. Runs every `git` subprocess with `GIT_LFS_SKIP_SMUDGE=1` when
   `lfs` is `false` or unset; omits the env when `lfs: true`.

## Submodule security caveat

When you enable `submodules: true`, GitHub Actions credentials are
inherited by the recursive clone. A nested repository that uses HTTPS
without an explicit auth scheme will share the parent installation's
token. Only enable submodule recursion when the GitHub App
installation has access to the nested repos and you trust the
submodule URLs declared in `.gitmodules`.

The default `submodules: false` is correct for almost every workflow.

## LFS behavior

Default `lfs: false` means LFS pointer files (small text blobs that
reference the actual object in LFS storage) appear verbatim in the
working tree. The review payload sees:

```
version https://git-lfs.github.com/spec/v1
oid sha256:....
size 12345
```

instead of the actual large file. This is intentional — the agent
should not spend network and disk bandwidth materializing large
binaries it would not review anyway. Combined with the unconditional
binary-path exclusion (`*.bin`, `*.parquet`, `*.pdf`, `*.png`,
`*.jpg`, `*.mp4`, `*.zip`) from spec §9.3, LFS-tracked binaries are
effectively invisible to the agent regardless of this flag.

Set `lfs: true` only if your repository tracks **text** content
through LFS (e.g., LFS-tracked SQL dumps you want the agent to
review). This is rare. When enabled, ensure the worker host has
`git-lfs` installed; otherwise the smudge filter silently no-ops and
you keep getting pointer files even with the flag on.

## How the keys flow

```
.review-agent.yml
  repo:
    submodules: true
    lfs: false
        │
        ▼  (loaded by @review-agent/config)
ReviewerConfig.repo
        │
        ▼  (worker handler — operator code)
provisionWorkspace({
  strategy: 'sparse-clone',
  ...,
  cloneHints: { submodules: true, lfs: false },
})
        │
        ▼  (workspace.ts → vcs.cloneRepo)
CloneOpts { submodules: true, lfs: false }
        │
        ▼  (platform-github clone.ts)
git clone --recurse-submodules --shallow-submodules ...
  (every git invocation runs with GIT_LFS_SKIP_SMUDGE=1)
```

The worker handler (which you write — the library does not own the
SQS-to-review wiring) is responsible for reading
`reviewerConfig.repo` and threading it into the
`provisionWorkspace` call.
