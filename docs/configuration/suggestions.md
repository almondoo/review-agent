# `suggestions` — committable suggestion blocks (#152)

The `suggestions` section controls whether and for which finding categories the
agent renders the `suggestion` field as a **platform-native committable block**
in inline review comments.

---

## Platform behaviour

| Platform | Rendering |
|---|---|
| **GitHub** | `suggestion` is formatted as a ` ```suggestion ` fenced block. GitHub's UI shows an "Apply suggestion" button; one click commits the proposed change without leaving the PR. |
| **CodeCommit** | ` ```suggestion ` syntax is not supported. The suggestion is rendered as an informational **Suggested fix:** fenced code block (`\`\`\`` language fence). No commit button — reviewers copy and apply manually. |

---

## Validity gating (GitHub only)

GitHub rejects a review with HTTP 422 if a `suggestion` block is anchored to a
line that is not within the diff's hunk context window. The GitHub adapter
therefore validates each anchor before posting:

- The anchor **`side`** must be `RIGHT` (new-file side). `LEFT`-side anchors are
  suppressed to a plain comment body.
- The anchor **`line`** must fall on a context (`' '`) or addition (`'+'`) line
  within the file's unified diff patch. Lines outside any hunk window, or on
  deletion-only lines, are suppressed.

**Suppression is fail-closed**: when no diff is available (e.g. the reviewer
payload was built without diff data), all suggestions are suppressed.

**Multi-line range (`start_line`) is supported (#165).**  When a finding
supplies a `startLine` that is strictly less than `line`, the adapter emits a
GitHub range suggestion covering `startLine`..`line` inclusive — but only when
every line in that range lies within a single diff hunk. If the range crosses a
hunk boundary (or any line is outside the diff context), the suggestion is
suppressed to a plain comment body.

---

## Configuration

```yaml
suggestions:
  enabled: true                        # default: true
  categories:                          # default: all categories
    - bug
    - security
    - performance
    - maintainability
    - style
    - docs
    - test
```

### `suggestions.enabled`

| Value | Behaviour |
|---|---|
| `true` (default) | Suggestions are rendered according to `categories` and platform-validity rules. |
| `false` | All `suggestion` fields are stripped before posting. Comment bodies are unchanged. |

### `suggestions.categories`

A list of finding categories for which suggestion blocks are rendered. The
agent will only emit a suggestion block for findings whose `category` matches
an entry in this list.

- **Default**: all seven categories (`bug`, `security`, `performance`,
  `maintainability`, `style`, `docs`, `test`).
- Findings whose `category` is **not** in the list have their `suggestion`
  field stripped (body preserved).
- Findings with **no `category` field** always keep their suggestion — no
  category is present to match against, so no category restriction applies.

**Example** — suggestions only for security and bug findings:

```yaml
suggestions:
  enabled: true
  categories:
    - security
    - bug
```

---

## Secret scanning

GitHub's "Apply suggestion" button commits the suggestion text verbatim into
the repository. To prevent an LLM-hallucinated secret from reaching source
history, the runner includes the `suggestion` field in the output gitleaks scan
pass (the same pass that already covers comment `body` and `summary`). If a
secret is detected the review is aborted (or the finding is redacted, depending
on the tag severity), matching the existing behavior for `body` and `summary`.

---

## Out of scope

The following are **not** implemented and are tracked as separate future issues:

- **Fix-commit (auto-push)**: automatically committing and pushing applied
  suggestions is outside scope. The agent's mission (spec §1.2) is read-only on
  source files. Committable suggestions give the human reviewer a one-click
  button; the agent never pushes code.

---

## Config reference link

See also: [config-reference.md](./config-reference.md) for a full table of
every top-level key.
