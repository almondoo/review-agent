# Skills

A **skill** is a Markdown file that is injected into the review agent's system
prompt for a specific repository or path. Skills let you teach the agent
domain-specific rules, project conventions, or security policies without
modifying the agent itself.

---

## What a skill does

When a skill is loaded, its Markdown content is appended to the agent's system
prompt before each review run. The agent reads the instructions and applies
them alongside the built-in review logic.

Example use cases:

- "Flag any usage of `eval()` in JavaScript as a security finding."
- "This service uses PII — treat any logging of user IDs as a critical issue."
- "Do not raise style findings for files under `vendor/`."
- Domain-specific coding conventions (naming, error handling, test coverage
  expectations).

---

## Configuring skills

Skills are declared in `.review-agent.yml` under the `skills` key:

```yaml
skills:
  - .review-agent/skills/security-baseline.md   # repo-local path
  - .review-agent/skills/pii-rules.md
```

Paths are relative to the repository root. The agent fetches each file from
the HEAD commit of the PR branch via the GitHub Contents API (or `read_file`
tool in server mode with `sparse-clone` workspace strategy).

Org-wide skills can be declared in the org central config
(`<org>/.github/review-agent.yml`) and will be concatenated with per-repo
skills when `extends: org` is set. See
[extends.md](../configuration/extends.md) for merge semantics.

---

## Writing a skill

A skill is a plain Markdown file. Keep it focused:

```markdown
# PII handling rules

- Any log statement that includes `userId`, `email`, or `phone` must
  be flagged as a **critical** security finding: "PII in logs."
- HTTP responses must never include raw database IDs in JSON payloads
  — use opaque tokens instead. Flag violations as **major**.
- `console.log` calls are acceptable in tests; flag them only in
  `src/` files.
```

Guidelines:

- Use imperative phrasing ("flag X as critical", "do not raise Y").
- Keep skills short (< 500 words). Long skills dilute prompt effectiveness.
- One concern per file. Compose multiple files rather than writing one giant
  skill.
- Test with `review-agent review --local --sample` to verify the agent picks
  up the instructions before wiring into CI.

---

## Path-scoped skills

To apply a skill only to files matching a glob pattern, use
`reviews.path_instructions` instead of (or in addition to) `skills`:

```yaml
reviews:
  path_instructions:
    - path: "src/payments/**"
      instructions: "Apply PCI-DSS level 1 scrutiny. Flag any card-number
        handling that does not go through the TokenService as critical."
```

`path_instructions` entries are inline (no file fetch) and scoped to the
matching files. They complement skills, which apply to the whole review.

Full reference: [path-instructions.md](../configuration/path-instructions.md).

---

## Bundled preset skills (via `extends`)

The bundled presets (`recommended`, `strict`, `security-focused`) already embed
effective skill-like instructions for their focus areas. Before writing a custom
skill, check whether extending a preset covers your need.

See [extends.md](../configuration/extends.md) for preset details.

---

## Third-party skill distribution

> **Note**: npm-distributed skill packages (e.g. `@review-agent/skill-owasp-top10`)
> are planned for a future release (tracked in issue #154, which depends on npm
> publish infrastructure). Until #154 lands, skills are file-based only (paths
> in the repository). Do not try to set `skills` to an npm package name — it
> will be treated as a file path and silently not found.

---

## See also

- [config-reference.md — `skills`](../configuration/config-reference.md#skills)
  — schema entry.
- [path-instructions.md](../configuration/path-instructions.md) — inline
  per-path instructions (no file fetch).
- [extends.md](../configuration/extends.md) — bundled presets that embed
  review policies.
- [migration-db-systemprompt.md](../configuration/migration-db-systemprompt.md)
  — migrating from legacy DB `systemPrompt` to file-based skills.
