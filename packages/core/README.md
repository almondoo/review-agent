# @review-agent/core

Pure domain logic, types, Zod schemas, and utilities for the `review-agent`
monorepo. **Zero I/O dependencies** — no `fs`, no network, no `process.env`,
no clock reads.

This package is the foundation: every other package (`platform-*`, `llm`,
`runner`, `action`, `server`, `cli`, `config`) depends on it.

## VCS abstraction

The `VCS` interface is the contract every platform adapter
(`platform-github`, `platform-codecommit`) implements. It has four
parts:

| Part                                | What it covers                                                    |
|-------------------------------------|-------------------------------------------------------------------|
| `platform` literal                  | `'github' \| 'codecommit'` — persisted in JobMessage / DB rows.   |
| `capabilities: VcsCapabilities`     | Static "what does this platform support" matrix (see below).     |
| `VcsReader`                         | `getPR` / `getDiff` / `getFile` / `cloneRepo` / `getExistingComments`. |
| `VcsWriter`                         | `postReview` / `postSummary`.                                     |
| `VcsStateStore`                     | `getStateComment` / `upsertStateComment`.                         |

`VCS = { platform; capabilities } & VcsReader & VcsWriter & VcsStateStore`.
Callers that only need a subset (e.g. the `recover sync-state` flow
uses just `VcsStateStore`) can depend on the narrower role.

### Capabilities matrix (shipped adapters)

| Capability                  | `platform-github` | `platform-codecommit` | Notes |
|-----------------------------|-------------------|------------------------|-------|
| `clone`                     | `true`            | `false`               | CodeCommit `cloneRepo` throws by design (spec §5.2.1); the runner uses `getDiff()`+`getFile()`. |
| `stateComment`              | `'native'`        | `'postgres-only'`     | GitHub embeds the canonical state in a hidden comment; CodeCommit's HTML escaping mangles the marker (spec §12.1.1). |
| `approvalEvent`             | `'github'`        | `'codecommit'`        | GitHub uses `pulls.createReview({event})`; CodeCommit's mapping target is `UpdatePullRequestApprovalState` (opt-in via `codecommit.approvalState`; #74). |
| `commitMessages`            | `true`            | `false`               | CodeCommit has no per-PR commit-listing API. |

The runner should branch on these flags **before** calling the
underlying method — e.g. the workspace provisioner refuses
`strategy: 'sparse-clone'` when `capabilities.clone === false` with a
typed operator-facing error, instead of letting the adapter throw a
lower-level "CodeCommit clone is not supported" message.

### Platform registry

Adapters register themselves at module load via
`registerPlatform(definition)`. The composition root (`action`,
`server`, `cli`) imports the adapter package once, which triggers
registration as a side effect; subsequent code looks up the adapter
through `getPlatform(prRef.platform).create(config)`.

```ts
import { getPlatform } from '@review-agent/core';
import '@review-agent/platform-github';     // registers under 'github'
import '@review-agent/platform-codecommit'; // registers under 'codecommit'

const def = getPlatform(jobMessage.prRef.platform);
const vcs = def.create({ token: '...' }); // adapter-specific config
```

**Intentional limitation:** `PRRef.platform` keeps its
`'github' | 'codecommit'` literal-union shape so JobMessage rows
already persisted to SQS / Postgres parse without a schema bump.
Widening `PRRef.platform` to plain `string` is v2 work (DB migration
+ JobMessage schema version). The registry is a dispatch helper, not
a type-erasure layer. See spec §22.x.

## Test helpers

The package re-exports a small set of fakes for unit tests in any
package that depends on `core`:

- `createFakeVCS({ ...overrides })` — full VCS surface; defaults to
  GitHub-like capabilities.
- `createFakeVcsReader` / `createFakeVcsWriter` /
  `createFakeVcsStateStore` — narrow-role fakes for tests that only
  exercise one role.
- `DEFAULT_FAKE_CAPABILITIES` — the GitHub-shaped capability defaults.

These factories never enforce capability ↔ behavior consistency
(a fake can advertise `clone: false` and still resolve `cloneRepo`).
Tests asserting that runtime code respects capability flags must do
that check themselves.

## Exports

- `VCS`, `PRRef`, `PR`, `Diff`, `DiffFile`, `CloneOpts`,
  `ExistingComment`, `VcsCapabilities`, `VcsReader`, `VcsWriter`,
  `VcsStateStore` — VCS adapter contract.
- `PlatformDefinition`, `PlatformId`, `getPlatform`,
  `registerPlatform`, `unregisterPlatform`, `listPlatforms`,
  `platformId` — platform registry.
- `createFakeVCS`, `createFakeVcsReader`, `createFakeVcsWriter`,
  `createFakeVcsStateStore`, `DEFAULT_FAKE_CAPABILITIES` —
  test helpers.
- `InlineComment`, `ReviewPayload`, `ReviewState`, `CostLedgerRow`,
  `Severity`, `Side` — review domain types.
- `InlineCommentSchema`, `ReviewOutputSchema` — Zod schemas validating
  LLM output, including refusals of broadcast mentions and
  shell-command bodies.
- `fingerprint(c)` — SHA-256 sliced to 16 hex chars (64 bits) for
  dedup.
- `ReviewAgentError` and discriminated subclasses — error taxonomy.

## License

Apache-2.0
