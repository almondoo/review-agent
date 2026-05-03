# Contributing

Thank you for your interest in this project!

This repository is published as open source so that anyone can read, learn from,
and reuse the code under the terms of the [LICENSE](../LICENSE). However, it is
maintained as a personal project and **external contributions are not accepted**.

## What this means

- **Pull Requests**: Will be closed without review. Please do not open PRs.
- **Issues**: Used for internal task tracking only. External issue reports
  are not accepted; please do not open issues for bug reports or feature
  requests.
- **Forks**: You are welcome to fork this repository and modify it for your own
  use, subject to the LICENSE.

## Why?

This project is maintained solo, and accepting external contributions would
require review and maintenance overhead that the author cannot commit to.

## If you found a security issue

Even though general issues are not accepted, security issues are taken
seriously. Please contact the repository owner directly rather than opening
a public issue or PR.

## Changesets (internal — for the maintainer)

Every PR (including internal task tracker PRs) that mutates a
public-API package must include a changeset. The public-API
packages and their stability commitments are listed in
[UPGRADING.md](../UPGRADING.md).

```bash
pnpm changeset            # interactive: pick packages, bump type, summary
```

Bump-type rules:

- `patch` — bug fixes, internal refactors, doc-only changes,
  dependency bumps that don't change the public API.
- `minor` — backwards-compatible additions to a public surface
  (new optional config field, new CLI subcommand, new provider).
- `major` — backwards-incompatible change to a public surface.
  **Major changesets MUST include a draft `## From X.y → Z.0`
  migration section in the changeset body.** That section is
  promoted into [UPGRADING.md](../UPGRADING.md) when the version
  ships.

Changes that touch only internal-only surfaces (per UPGRADING.md
"Internal-only surfaces") may use `patch` even when they would
otherwise look like minor / major changes — the SemVer guarantee
explicitly excludes those surfaces.

If unsure whether a change is breaking, default to `major` and get
the migration section drafted. It's cheaper to soft-revert a major
bump in review than to ship a silent breakage.
