# Large-PR / Monorepo Strategy (`large_pr`)

> **Availability**: v1.2 (#158). Requires `@review-agent/runner` >= 1.2.0.

By default, when a PR exceeds the `reviews.max_files` or `reviews.max_diff_lines`
caps the runner **splits the diff into chunks** and reviews each chunk in
sequence, up to `large_pr.max_chunks` passes. This replaces the previous
hard-skip behaviour (no LLM call, only a summary notice).

## Configuration

```yaml
large_pr:
  enabled: true           # default; set false to restore legacy skip behaviour
  max_chunks: 5           # maximum LLM passes per PR (default 5)
  prioritization:         # ordered criteria; alphabetical is always the final tiebreak
    - path_instructions   # path_instructions-matched files first
    - diff_size           # larger diffs earlier (descending)
```

All keys are optional — omitting the entire `large_pr` section is equivalent to
the defaults shown above.

## How chunking works

1. After `reviews.path_filters` removes excluded files, the runner checks whether
   the remaining files exceed `reviews.max_files` or `reviews.max_diff_lines`.
2. If a cap is exceeded **and** `large_pr.enabled: true`, the files are **sorted**
   by the `prioritization` criteria, then **greedily split** into chunks that each
   fit within the per-chunk caps.
3. Chunks are reviewed in order (highest-priority files first). The runner
   invokes the LLM once per chunk.
4. After `max_chunks` chunks, any remaining files are skipped with reason
   `max_chunks_exceeded`.

## Prioritization criteria

Criteria are applied in the listed order; ties fall through to the next:

| Criterion | Effect |
|---|---|
| `path_instructions` | Files matching any `reviews.path_instructions` glob come first. |
| `diff_size` | Files with more changed lines (additions + deletions) come earlier. |
| `alphabetical` | Lexicographic ascending. Always applied as the final tiebreak. |

Omitting a criterion from the list means it has no effect on ranking (beyond the
implicit alphabetical tiebreak that is always applied).

## Coverage reporting (no silent truncation)

The PR summary always includes a coverage line:

```
Large-PR review: reviewed 42 files across 5 chunks. Skipped 8 files (max_chunks_exceeded).
```

Possible skip reasons:

- `max_chunks_exceeded` — file was in a chunk beyond `large_pr.max_chunks`.
- `budget_exhausted` — cost cap (`cost.max_usd_per_pr`) reached mid-review.
- `path_filter` — matched a `reviews.path_filters` glob (same as before).

## Cost impact

With `large_pr.enabled: true` (the default), a large PR may trigger **multiple
LLM passes**. The `cost.max_usd_per_pr` cap applies **across all chunks**, not
per chunk, so cost is bounded. Effective controls:

- Lower `large_pr.max_chunks` to limit the maximum number of passes.
- Lower `cost.max_usd_per_pr` to stop mid-review when the budget is exhausted.
- Set `large_pr.enabled: false` to restore the legacy no-LLM-call skip for very
  large PRs where you prefer an explicit skip over a partial review.

## Cross-chunk context limits

Each chunk is an independent LLM call. The model **does not** have direct access
to findings from earlier chunks within the same pass. Cross-chunk deduplication
ensures the same finding is not posted twice, but the model cannot reference
"what I said about file A" when reviewing file B in a later chunk.

The `read_file` / `glob` / `grep` tools are available within each chunk and can
retrieve related files from the workspace, which partially bridges this limitation.

## Legacy skip behaviour (`enabled: false`)

```yaml
large_pr:
  enabled: false
```

When `enabled: false`, caps behave exactly as in v1.1 and earlier:

- `reviews.max_files` exceeded → `aborted.reason: max_files_exceeded`, no LLM call.
- `reviews.max_diff_lines` exceeded → `aborted.reason: max_diff_lines_exceeded`, no LLM call.

Use this when you want a hard "do not review large PRs" policy.

## Server mode

The server queue handler receives the fully-wired `ReviewJob` from the operator's
injection point; `large_pr` flows through that seam automatically. No server-side
change is needed.
