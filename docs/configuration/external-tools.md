# External Tools (SARIF Ingestion)

review-agent can ingest SARIF 2.1.0 output produced by CI static-analysis tools
(CodeQL, Semgrep, ESLint SARIF formatter, etc.) and merge those findings with the
AI review results before posting inline comments.

**The agent does not run external tools itself.** It reads SARIF files that your CI
pipeline has already generated and written to the workspace.

## Configuration

```yaml
external_tools:
  tools:
    - name: codeql
      sarif_path: results/codeql.sarif
      merge_policy: tool_wins   # optional; default: tool_wins

    - name: semgrep
      sarif_path: semgrep.sarif
      merge_policy: annotate
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string (required) | — | Display name for the tool. Used in comment bodies and annotation notes. |
| `sarif_path` | string (required) | — | Path to the SARIF output file. Resolved relative to the repo root / working directory at review time. |
| `merge_policy` | `tool_wins` \| `ai_wins` \| `annotate` | `tool_wins` | How to resolve conflicts when both the AI and the external tool flag the same location. |

## SARIF Format

review-agent parses **SARIF 2.1.0** (the OASIS standard used by GitHub Advanced
Security, CodeQL, Semgrep, and most modern static-analysis tools). Required fields
per result:

- `runs[].tool.driver.name` — tool name (used in comment body prefix)
- `runs[].results[].locations[].physicalLocation.artifactLocation.uri` — file path
- `runs[].results[].locations[].physicalLocation.region.startLine` — line number

Results missing a `physicalLocation` or `startLine` are silently skipped with a
warning logged to stderr. Malformed or unparseable SARIF content also emits a
warning and skips that tool; the review continues with AI findings only.

## SARIF `level` → Severity mapping

| SARIF `level` | review-agent severity |
|---|---|
| `error` | `major` |
| `warning` | `minor` |
| `note` | `info` |
| (absent) | `minor` |

## Merge Policies

All findings — AI and external — share the same fingerprint scheme
(`path:line:ruleId:suggestionType`). Two findings are considered duplicates when
their fingerprints match.

### `tool_wins` (default)

Fingerprint conflict: the external tool finding is kept; the AI finding is dropped.
Non-conflicting findings from both sides are kept.

Use this when the external tool is authoritative (e.g. a security scanner whose
findings you never want the AI to override).

### `ai_wins`

Fingerprint conflict: the AI finding is kept; the external duplicate is dropped.
Non-conflicting external findings are still added.

Use this when you prefer the AI's richer context over the tool's raw output, but
still want non-overlapping tool findings surfaced.

### `annotate`

Fingerprint conflict: the AI finding is kept and its comment body gains a
`_Also flagged by <name> (`<ruleId>`)_` note. The external duplicate is dropped.
Non-conflicting external findings are added.

Use this when you want a single comment per location that acknowledges both sources.

## Dedup with previous reviews

External findings are subject to the same incremental dedup as AI findings: if a
finding's fingerprint already appears in the previous review's state (i.e. it was
already posted), it is not re-posted. Findings muted via 👎 feedback suppression
rules are also excluded.

## Scope and limitations

- **No URL / stdin support.** `sarif_path` must be a filesystem path.
- **No tool-specific non-SARIF formats.** If a tool emits its own JSON format
  (e.g. ESLint's default output), use its SARIF output flag first
  (`eslint --format @microsoft/eslint-formatter-sarif`).
- **Server mode.** The server webhook handler does not currently read
  `external_tools.tools[].sarif_path` from the operator filesystem. This seam
  exists in the queue handler; SARIF ingestion in server mode requires a custom
  `externalTools` injection via the `ReviewJob` type and is not yet wired up as a
  first-class feature.
