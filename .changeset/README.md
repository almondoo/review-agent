# Changesets

This directory holds [changeset](https://github.com/changesets/changesets)
files describing pending version bumps for packages in this monorepo.

Run `pnpm changeset` to add a new changeset describing your changes. It will
prompt you for affected packages, the bump type (major / minor / patch), and a
short summary that becomes the changelog entry.

Run `pnpm changeset:version` to consume all pending changesets and update
package versions + CHANGELOG.md files.
