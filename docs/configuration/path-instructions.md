# `path_instructions` — per-glob review guidance + related-file auto-fetch

`reviews.path_instructions` is a YAML array that tells the agent to
apply extra review guidance when a PR touches files matching a glob
pattern. Each entry can also opt in to **auto-fetch** of related files
(tests / type declarations / siblings) so the LLM has the context
without spending tool-call budget asking for it.

## Schema

```yaml
reviews:
  path_instructions:
    - path: "src/**/*.ts"                # glob (required)
      instructions: "Use strict types."   # free-form prompt fragment (required)
      auto_fetch:                         # optional; omit to disable
        tests: true                       # default: true
        types: true                       # default: true
        siblings: false                   # default: false
```

### `path` — glob pattern

The supported glob subset:

| Syntax  | Meaning                                                          |
|---------|------------------------------------------------------------------|
| `*`     | Match any sequence of characters **within a path segment**. Does not cross `/`. |
| `**`    | Match any sequence including path separators. Use `**/foo` to mean "any-or-zero segments, then foo". |
| literal | All other characters match themselves; regex metacharacters (`.`, `+`, `(`, etc.) are escaped. |

Patterns are validated at config load time. Typos like
`src/utils/\*.ts` (with a literal backslash) and pathological inputs
(empty strings, NUL bytes) are rejected up front rather than silently
never matching at runtime.

### `instructions` — guidance string

Free-form text appended to the system prompt as a bullet under
`## Path Instructions`:

```
## Path Instructions
- For files matching `src/**/*.ts`: Use strict types.
```

The LLM sees this regardless of which specific files in the diff
match — the guidance is a *prior*, not a per-file directive.

### `auto_fetch` — related-file prefetch

When the diff touches a file matching `path`, the runner pre-fetches
related files via the workspace tools and threads their content into
the LLM prompt as a `<related_file>` block under `<related_files>`,
between the `<untrusted>` PR metadata and the `<diff>` block.

| Field      | Default | Resolution                                                                                          |
|------------|---------|-----------------------------------------------------------------------------------------------------|
| `tests`    | `true`  | Looks for `<dir>/<base>.test.<ext>`, `<dir>/<base>.spec.<ext>`, `<dir>/__tests__/<base>.test.<ext>`. Skipped when the changed file itself is a test file. |
| `types`    | `true`  | Looks for `<dir>/<base>.d.ts`. Only fires for `.ts/.tsx/.js/.jsx` source files. Skipped when the changed file itself is a `.d.ts`. |
| `siblings` | `false` | Looks for `<dir>/index.<ext>` — the most likely "I imported from a sibling" target. Opt-in because the broader sibling fan-out is high-noise. |

Companion files that don't exist are silently skipped — the runner
doesn't fail the review when a test file hasn't been written yet.

### Budget caps

Auto-fetch is bounded by `DEFAULT_AUTO_FETCH_BUDGET`:

| Cap                 | Default |
|---------------------|---------|
| Max files fetched   | 5       |
| Bytes per file      | 50 000  |
| Total payload bytes | 250 000 |

Hitting any cap stops the fetch loop early. The last fetched file is
*truncated* to fit the remaining headroom rather than wholesale
skipped — so the LLM at least gets a partial picture of the largest
file. A trailing HTML comment in the `<related_files>` block notes
when the budget was reached:

```
</related_files>
<!-- auto-fetch budget reached; 5 file(s) materialized (250000 bytes) -->
```

These defaults are not currently overridable from `.review-agent.yml`
— operators with unusual repos can ship a custom runner deployment
that constructs `ReviewJob` directly with a tighter / looser
`AutoFetchBudget`.

## Precedence

When multiple `path_instructions` entries match the same changed
file, **the first matching entry wins**. Order in
`.review-agent.yml` determines precedence. We don't support multiple
overlapping auto-fetch policies for the same file because the budget
caps would otherwise double per overlap, and operator intent gets
ambiguous fast.

## Server-mode caveat

Auto-fetch requires a populated workspace. In Server mode this means
operators must enable `server.workspace_strategy` (see
`docs/deployment/aws.md` §8.1). With `workspace_strategy: 'none'`
(the v0.2 default), no files are on disk; the runner falls through
to a no-op auto-fetch and the system prompt's path-instructions text
is still applied (without the inline `<related_files>` block).

In Action mode the workspace is provisioned by `actions/checkout`
before the Action runs, so auto-fetch always works.

## Security

The runner's tool dispatcher refuses denylisted paths (`.env*`,
`secrets/`, `private/`, `*.pem`, `credentials*.json`,
`service-account*.json`) and any path that would traverse out of
the workspace, contain a NUL byte, or follow a symlink. Auto-fetch
inherits those refusals — a `path_instruction` matching a
denylisted candidate produces no fetch and no error.

## Example

```yaml
reviews:
  path_instructions:
    - path: "src/server/**/*.ts"
      instructions: |
        Server code. Reject anything that touches request input
        without explicit Zod validation at the boundary.
      auto_fetch:
        tests: true
        types: true
        siblings: false

    - path: "**/*.sql"
      instructions: |
        Migrations are append-only — never mutate or drop a column
        in an existing migration; ship a new one instead.
      # No auto_fetch: SQL files don't have test/type companions.

    - path: "packages/runner/src/agent.ts"
      instructions: |
        The agent loop. Watch for new tool calls that bypass the
        whitelist; check the middleware order.
      auto_fetch:
        tests: true
        types: false
        siblings: true   # pulls in `src/index.ts`, the public surface.
```

## See also

- `SECURITY.md` — branch-protection wiring + deny-list semantics.
- `docs/deployment/aws.md` §8.1 — Server-mode workspace strategy.
- `docs/specs/review-agent-spec.md` §12 — incremental review (auto-fetch interacts with incremental scoping).
