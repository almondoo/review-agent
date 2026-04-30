# @review-agent/core

Pure domain logic, types, Zod schemas, and utilities for the `review-agent`
monorepo. **Zero I/O dependencies** — no `fs`, no network, no `process.env`,
no clock reads.

This package is the foundation: every other package (`platform-*`, `llm`,
`runner`, `action`, `server`, `cli`, `config`) depends on it.

## Exports

- `VCS`, `PRRef`, `PR`, `Diff`, `DiffFile`, `CloneOpts`, `ExistingComment` —
  VCS adapter interface used by `platform-github` and `platform-codecommit`.
- `InlineComment`, `ReviewPayload`, `ReviewState`, `CostLedgerRow`,
  `Severity`, `Side` — review domain types.
- `InlineCommentSchema`, `ReviewOutputSchema` — Zod schemas validating LLM
  output, including refusals of broadcast mentions and shell-command bodies.
- `fingerprint(c)` — SHA-256 sliced to 16 hex chars (64 bits) for dedup.
- `ReviewAgentError` and discriminated subclasses — error taxonomy.

## License

Apache-2.0
