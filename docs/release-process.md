# Release Process

This document describes how `review-agent` releases are cut, which packages
are in scope for publishing, and how the CHANGELOG is maintained.

---

## Package publishing status

All packages in this monorepo are currently marked `"private": true` and are
**not published to npm**. Distribution is via:

- **GitHub Action** — consumed directly as `almondoo/review-agent@<tag>`.
- **Docker image** — built from `Dockerfile`, tagged and pushed to a container
  registry by CI on release.
- **Source reference** — the repo is published as OSS for operators who want to
  self-build.

If individual packages are ever opened for npm publishing, each must have a
`publishConfig.access` field added and its `"private": true` field removed.
The `@review-agent/` npm scope would be used.

---

## Release types

| Type | SemVer bump | Criteria |
|---|---|---|
| **Patch** | `x.y.Z` | Bug fixes, internal refactors, doc-only changes, security fixes with no API change. |
| **Minor** | `x.Y.0` | Backwards-compatible new features (new config field, new CLI subcommand, new VCS platform adapter, new AI provider driver). |
| **Major** | `X.0.0` | Breaking changes to any public surface defined in `UPGRADING.md`. Requires a migration section. |
| **Hotfix** | `x.y.Z` (patch on release branch) | Critical production fix on a shipped version. See [Hotfix procedure](#hotfix-procedure). |

Public API surfaces and stability commitments are defined in
[`UPGRADING.md`](../UPGRADING.md). Changes to internal-only surfaces may use
`patch` regardless of apparent scope.

---

## Normal release workflow

### 1. Add a changeset during development

Every PR that modifies a (future) publishable package must include a changeset:

```bash
pnpm changeset   # interactive: pick affected packages, bump type, summary
```

The changeset file lands in `.changeset/<slug>.md`. Commit it alongside the
code change.

Bump-type guidance:

- `patch` — bug fix, refactor, doc change, dep bump without API change.
- `minor` — new backwards-compatible feature.
- `major` — breaking change. **The changeset body must include a `## From X.y → Z.0` migration section.** That section is promoted into `UPGRADING.md` when the version ships.

### 2. Merge feature work to `develop`

All work lands on `develop` via the internal PR workflow. Wave releases are
batched per issue group (see [`docs/roadmap.md`](./roadmap.md)).

### 3. Version bump

When a wave is ready to ship:

```bash
# From develop (or a release branch for major versions):
pnpm changeset version
```

This command:

- Reads all pending `.changeset/*.md` files.
- Bumps the version in each affected `package.json` according to the highest
  bump type across all changesets touching that package.
- Generates or appends per-package `CHANGELOG.md` entries (Keep-a-Changelog
  format) from the changeset descriptions.
- Deletes the consumed `.changeset/*.md` files.

Commit the version bump:

```bash
git add .
git commit -m "chore(release): version packages"
```

### 4. Update the root CHANGELOG

`pnpm changeset version` generates per-package changelogs, but the root
`CHANGELOG.md` is maintained as a hand-curated wave summary. After the version
bump, update the root `CHANGELOG.md`:

- Move the `[Unreleased]` content to a versioned section with today's date.
- Summarise the operator-visible highlights (not every package bump — focus on
  features, breaking changes, and migration steps).
- Update the comparison URLs at the bottom of the file.

### 5. Open a `develop → main` PR

```bash
gh pr create --base main --head develop --title "chore(release): vX.Y.Z"
```

The PR description should link to the relevant wave issues and include the
migration steps from `UPGRADING.md` if this is a major release.

### 6. Tag and push after merge

After the `develop → main` PR is merged:

```bash
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

CI picks up the tag and builds the Docker image and GitHub Action release
artifact.

### 7. Create a GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | head -n -1)
```

---

## Hotfix procedure

A hotfix is a patch-bump release on a shipped version, bypassing `develop`.

```bash
# Create a hotfix branch from the release tag:
git checkout -b hotfix/X.Y.Z vX.Y.(Z-1)

# Apply the fix. Add a changeset:
pnpm changeset   # bump type: patch

# Version, commit, tag:
pnpm changeset version
git add . && git commit -m "chore(release): vX.Y.Z hotfix"
git tag vX.Y.Z
git push origin hotfix/X.Y.Z vX.Y.Z

# Back-merge to develop:
git checkout develop && git merge hotfix/X.Y.Z
git push origin develop

# Delete the hotfix branch:
git push origin --delete hotfix/X.Y.Z
```

The hotfix tag triggers the same CI pipeline as a normal release. Update the
root `CHANGELOG.md` on `develop` after the back-merge.

---

## CHANGELOG strategy

**Decision**: hand-curated root `CHANGELOG.md` + Changeset-generated per-package changelogs.

**Rationale**: all packages are currently private (no npm publishing), so
per-package machine-generated changelogs serve an internal tracking purpose.
The root `CHANGELOG.md` serves operator-facing communication — users consuming
the GitHub Action or Docker image care about wave-level features, breaking
changes, and migration steps, not per-package version bumps. The two levels
complement each other:

| Level | Source | Audience | Format |
|---|---|---|---|
| Per-package `packages/*/CHANGELOG.md` | Generated by `pnpm changeset version` | Internal / future npm consumers | Keep-a-Changelog, granular |
| Root `CHANGELOG.md` | Hand-curated per wave | Operators using the Action / Docker image | Keep-a-Changelog, wave summaries |

The root `CHANGELOG.md` is updated manually as part of step 4 above. It is not
generated automatically; keep it focused on operator impact, not implementation
detail.

---

## Pre-release verification checklist

Before opening the `develop → main` PR:

- [ ] `pnpm typecheck` green from repo root.
- [ ] `pnpm lint` green from repo root.
- [ ] `pnpm test:coverage` green; per-package thresholds met.
- [ ] `pnpm build` green; `dist/` contains `.js`, `.cjs`, `.d.ts`, `.d.cts`.
- [ ] All wave Acceptance Criteria satisfied (check each issue).
- [ ] Root `CHANGELOG.md` updated with the wave summary.
- [ ] Per-package `CHANGELOG.md` files generated by `pnpm changeset version`.
- [ ] `UPGRADING.md` updated if the release contains breaking changes.
- [ ] `docs/roadmap.md` updated to reflect the new wave status.
- [ ] Docker smoke test passes (`docker compose -f docker-compose.yml up --build`).
