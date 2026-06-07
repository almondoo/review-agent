# GitHub Actions Marketplace — publish runbook

This document describes the repository-side preparations that make
`review-agent` publishable to the GitHub Actions Marketplace and explains
the tag strategy evaluators and users should follow.

Spec references: §4.1 (Action inputs/permissions), §18.1 (Marketplace
listing requirements), §18.3 (versioned tag strategy).

---

## Repository-side checklist (already done)

- [x] `packages/action/action.yml` has `name:`, `description:`, `author:`,
  and `branding:` (`icon: check-circle`, `color: blue`).
- [x] `packages/action/action.yml` declares `runs.using: node24`.
- [x] `packages/action/action.yml` lists all inputs with `description:`
  and `required:` fields.
- [x] `release.yml` force-updates `v1` and `v1.x` floating tags after
  every release (see [Versioned tag management](#versioned-tag-management)
  below).
- [x] `LICENSE` (Apache-2.0) is at the repository root.
- [x] `README.md` contains a quickstart section and links to
  `docs/getting-started/action.md`.

---

## Versioned tag management

The release workflow (`release.yml`) automatically maintains two
floating tags on every published GitHub release:

| Tag | Points at | User pin recommendation |
|---|---|---|
| `v1` | latest `v1.x.y` | `almondoo/review-agent@v1` — always up to date within v1 |
| `v1.x` | latest `v1.x.y` (e.g. `v1.2`) | `almondoo/review-agent@v1.2` — receive patches only |
| `v1.x.y` | immutable | `almondoo/review-agent@v1.2.3` — pinned, never updated |

The `v1` tag is the recommended pin in workflow files (see
`examples/workflows/review-agent.yml`). It tracks the latest stable v1
release automatically — users get security fixes and new features without
needing to update their workflow files.

Major-breaking changes increment the major version (`v2`, etc.) and the
`v1` tag is never force-updated past a breaking change.

---

## Manual publish steps (Marketplace)

> **Note:** Marketplace publication is a manual, one-time UI action
> performed by the repository maintainer. It cannot be automated via
> workflow or CLI. The steps below apply to the repository at
> `almondoo/review-agent`.

1. **Verify branding.** Open
   `packages/action/action.yml` and confirm `branding.icon` and
   `branding.color` are set. Currently: `icon: check-circle`,
   `color: blue`. Both must be valid
   [Marketplace values](https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#brandingcolor).

2. **Create a GitHub release** (if one does not already exist for the
   target version):
   - Go to **Releases → Draft a new release**.
   - Tag: `vX.Y.Z` (e.g. `v1.0.0`). Target: `main`.
   - Fill in release notes.
   - Click **Publish release**. The `release.yml` workflow runs and
     force-updates `v1` / `v1.x` tags automatically.

3. **Publish the Action to the Marketplace:**
   - On the release page, click **Marketplace** in the right-hand sidebar
     (or navigate to the release and look for the "Publish this Action to
     the Marketplace" prompt at the top of the edit view).
   - GitHub will validate `action.yml` against Marketplace requirements.
   - Select **Primary category** (Utilities or Code quality) and optionally
     a **Secondary category**.
   - Click **Publish to Marketplace**.

4. **Verify the listing** at
   `https://github.com/marketplace/actions/review-agent`. Confirm the
   branding icon, description, and install instructions appear correctly.

5. **Update `README.md`** to reflect the Marketplace URL if not already
   present (the quickstart section links to
   `docs/getting-started/action.md` which links here).

---

## Re-publishing after a new release

No manual action is needed after the initial publish. GitHub
automatically updates the Marketplace listing when a new release is
created, because `action.yml` is re-read from the new tag. The `release.yml`
workflow keeps `v1` / `v1.x` pointing at the new release.

---

## References

- [GitHub docs: Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/sharing-automations/creating-actions/publishing-actions-in-github-marketplace)
- [Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions)
- `docs/getting-started/action.md` — user-facing quickstart
- `examples/workflows/review-agent.yml` — copy-paste workflow template
