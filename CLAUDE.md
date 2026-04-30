# CLAUDE.md — review-agent project briefing

This file briefs Claude (and future agents) on how to pick up implementation
work in this repository. Read it first whenever starting a new session.

## What this project is

Self-hosted, OSS, multi-provider AI code review agent. Built on the Vercel AI
SDK with a thin custom agent loop. Distributed as **GitHub Action** (v0.1),
**Hono webhook server on Lambda + SQS** (v0.2), and **CLI** (v0.2) from a
single TypeScript monorepo. Supports Anthropic (default), OpenAI, Azure
OpenAI, Google, Vertex, Bedrock, and any OpenAI-compatible endpoint.

This repo is a **personal project published as OSS for reference**. External
contributions (PRs, issues) are not accepted (`README.md`, `.github/CONTRIBUTING.md`).
Issues are used for **internal task tracking only**.

## Source of truth

| What | Where |
|---|---|
| Implementation specification | [`docs/specs/review-agent-spec.md`](./docs/specs/review-agent-spec.md) — the source of truth for all design decisions. Issue bodies cite §X.Y of this file. |
| Product vision (long-term) | [`docs/specs/prd.md`](./docs/specs/prd.md) — v1.0+ future direction. Don't treat as binding for v0.1–v0.3. |
| Per-task acceptance criteria | GitHub Issues #1–#37 on `almondoo/review-agent`. Read with `gh issue view <N>`. |
| Implementation order + dependencies | [`docs/roadmap.md`](./docs/roadmap.md) |
| Unresolved decisions | GitHub Issue with label `question` (search: `gh issue list --label question`). |

When the spec and an Issue disagree, the spec wins. When the spec is silent on
something, surface it as a question rather than inventing an answer (spec §22).

## How to work on this repo

1. Pick the next unblocked Issue from [`docs/roadmap.md`](./docs/roadmap.md).
2. Read its full body: `gh issue view <N> --repo almondoo/review-agent`. The
   body has Summary / Acceptance Criteria / Spec References / Dependencies /
   Notes — all five matter.
3. For each `§X.Y` reference, open the corresponding section in
   `docs/specs/review-agent-spec.md`.
4. If the Issue is blocked by an open question (see the `question`-labelled
   tracking issue), **stop and surface it** instead of guessing.
5. Implement. Keep `core` zero-I/O; never let it import `fs`, `node:net`,
   provider SDKs, or `process.env`.
6. Verify locally: `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build`
   must all pass before considering the task complete.
7. Commit with Conventional Commits format. Group commits by logical change,
   not by file. Do **not** push or create PRs without explicit user approval.

## Stack (decided — do not relitigate)

- **Language**: TypeScript 5.6.3, ESM-only, strict + `noUncheckedIndexedAccess`
  + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + NodeNext.
- **Runtime**: Node.js 24.14.x LTS.
- **Package manager**: pnpm 10.33.0 workspace monorepo. Lockfile committed.
- **Lint + format**: Biome 2.x — single tool, no ESLint, no Prettier.
- **Test**: Vitest 2.x with v8 coverage. Threshold: lines/funcs/stmts 95%, branches 90%.
- **Build**: tsup 8.x — ESM + CJS dual output with `.d.ts` per package.
- **Schema validation**: Zod 3.x for every external/LLM input.
- **LLM**: Vercel AI SDK (`ai` ^4.x) + `@ai-sdk/anthropic` (default driver).
  Use `generateObject` with the Zod `ReviewOutputSchema` from `@review-agent/core`.
- **Versioning**: Changesets, per-package.

Exact pinned versions are in `package.json` and `packages/*/package.json`. Do
not bump majors casually — every minor lift across the matrix risks breaking
provider parity.

## Conventions

- **Imports across packages**: relative file imports inside a package end with
  `.js` (NodeNext requirement, even though source is `.ts`).
- **No `enum`s**. Use `as const` arrays + `(typeof X)[number]` unions
  (see `packages/core/src/review.ts` for the pattern).
- **No `null!` or non-null assertions**. Biome rejects them.
- **No `any`**. Biome rejects it.
- **File names**: kebab-case (`platform-github`, `cost-ledger.ts`).
- **Type names**: PascalCase. Interfaces and types are interchangeable; we use
  `type` for object shapes by default.
- **Internal prompts are always English** (spec §2.2). Output language is
  configurable via `.review-agent.yml` `language:` and `REVIEW_AGENT_LANGUAGE` env.
- **No code modification by the agent itself** (mission §1.2). Read-only on
  source; write-only on PR comments.

See spec §21 for the full coding standard.

## Package boundaries

```
core            # zero I/O. Types, schemas, fingerprint, errors. Foundation.
platform-*      # VCS adapters. Implements VCS interface from core.
llm             # LlmProvider abstraction + per-provider drivers.
runner          # Agent loop, tool dispatch, middleware. Provider-agnostic.
config          # .review-agent.yml schema/loader. Resolves provider.
action          # GitHub Action wrapper. Thin entry point.
server          # Hono webhook server (Lambda + Node adapters). v0.2+.
cli             # `review-agent` CLI bin. v0.2+.
eval            # promptfoo + golden PR fixtures. Not in build artifact.
```

`core` depends on nothing project-internal. `platform-*` depends only on
`core`. `runner` depends on `core` + `llm`. `action` / `server` / `cli`
compose everything. Never import from another package's `src/internal/`.

## Distribution status

- v0.1 issue #1 (`@review-agent/core`) is shipped on `main`. See commits
  `4475e3d` (docs/policy) and `e681bf4` (monorepo + core).
- v0.1 #2–#13: open, not started.
- v0.2 + v0.3: open, not started.

## What is NOT used (despite being tempting)

- ❌ Claude Agent SDK subagent memory — replaced with Postgres `review_history` so
  every provider can read it (spec §2.1, §7.6).
- ❌ Claude PreToolUse / PostToolUse hooks — replaced with our own middleware
  in `packages/runner/src/middleware/` so every provider runs through it.
- ❌ Tool-surface restriction via Claude SDK config — our agent loop only ever
  exposes `read_file` / `glob` / `grep` to any provider.
- ❌ Bun. Node 24 LTS only.
- ❌ Turborepo. Plain pnpm `-r` is enough.
- ❌ ESLint + Prettier. Biome only.

## Operating constraints (Claude-specific)

- Use `gh issue view <N>` and `gh issue list` freely. **Do not** run
  `gh issue create / edit / comment / close` — it is an external write that
  the user reserves for themselves (CLAUDE.md user rule ③). When you draft
  body text for a new Issue, write it to a temp file and tell the user the
  command to run.
- Do not run `git push`, `git push --force`, or `gh pr create` without the
  user explicitly asking for that specific action. A general "go ahead and
  implement" does not authorize push.
- Use `Read` / `Grep` / `Glob` / `Edit` / `Write` tools, not raw shell
  `cat` / `grep` / `find` / `sed` (CLAUDE.md user rule).
- Spec file is intentionally large (~118 KB). Read it in section-targeted
  slices, not all at once.

## Verification checklist before reporting an Issue done

- [ ] `pnpm typecheck` green from repo root.
- [ ] `pnpm lint` green from repo root.
- [ ] `pnpm test:coverage` green; per-package coverage ≥ 95% lines.
- [ ] `pnpm build` green; `dist/` contains `.js`, `.cjs`, `.d.ts`, `.d.cts`.
- [ ] Every checkbox in the Issue's Acceptance Criteria is satisfied.
- [ ] No new dependency added that conflicts with stack table above.
- [ ] No commit on `main` until user authorizes.
