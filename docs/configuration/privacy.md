# Privacy

`.review-agent.yml`'s `privacy:` section controls what review-agent
will accept from the LLM into operator-visible output. It is the
operator-facing surface of the spec §7.3 / §7.4 hardening that keeps
prompt-injected models from exfiltrating PR content through review
comments.

Today the section ships one key — `allowed_url_prefixes` — implemented
in `#85` for v1.x. Two siblings are tracked as separate issues and
will land later:

- `privacy.deny_paths` — additional file paths the runner must refuse
  on top of the built-in deny list (spec §7.4). Tracked as `#86`.
- `privacy.redact_patterns` — additional secret patterns to redact in
  diff and output scans on top of gitleaks defaults. Tracked as `#87`.

Spec reference: §7.3 (prompt-injection defense, #4 URL allowlist),
§7.7 (output validation schema).

---

## `allowed_url_prefixes`

The URL allowlist is the hard backstop against the
"Comment-and-Control" prompt-injection class (April 2026): if a
prompt-injected payload tricks the model into emitting a link
`https://attacker.example/leak?...`, the URL allowlist refine in
`ReviewOutputSchema` rejects the entire review output, the runner
retries once with a corrective prompt, and on a second failure the
review aborts gracefully (see [Failure modes](#failure-modes) below).

### Closed-world default

The allowlist is **closed-world**. With no `allowed_url_prefixes`
configured, the only URLs the model is permitted to emit are links
that point into the PR's own repository — anything else fails
validation. This is intentional: every additional allowed prefix is
an additional channel an injected payload can attempt to abuse, so
the default keeps the surface minimal.

`InlineComment.body`, `InlineComment.suggestion`, and the top-level
`summary` are all scanned (the GitHub "Apply suggestion" button copies
`suggestion` verbatim into source, so a bad URL there would persist
across the PR life cycle).

### What counts as "the PR's own repo"

A URL points into the PR's own repo when **both** of the following
hold:

- Its host matches the PR's host exactly (case-insensitive). The host
  is `github.com` for GitHub SaaS deployments and the GHES hostname
  (e.g. `ghe.example.com`, `ghe.example.com:8443`) for Enterprise
  Server deployments. The Action derives it from the
  `GITHUB_SERVER_URL` environment variable that the GitHub Actions
  runner exports; the CLI derives it the same way for the github
  platform.
- Its path starts with `/<owner>/<repo>` (case-insensitive). Path
  prefix is matched exactly — `/owner/repo` and `/owner/repo/...`
  match, `/owner/repo-other` does not.

Hosts MUST match exactly; an earlier host-agnostic design would have
permitted `https://evil.example/<owner>/<repo>/...` to slip past the
allowlist because it shares the path prefix. See the inline note on
`isPrOwnRepoUrl` in `packages/core/src/url.ts`.

#### CodeCommit caveat

CodeCommit PRs have no fixed PR-UI host — the AWS console URL is
region-scoped, e.g. `<region>.console.aws.amazon.com/...`. For
`--platform codecommit` the CLI passes the sentinel host
`'codecommit.invalid'` (RFC 6761 reserves `.invalid` for guaranteed
non-resolution). The own-repo check therefore never matches for
CodeCommit reviews; operators who need to allow links into the AWS
console must list them explicitly under `allowed_url_prefixes`.

### How `allowed_url_prefixes` entries are matched

Each entry is matched against the candidate URL with `String.prototype.startsWith`:

- Comparison is exact-string — there is no normalization, no `*`
  glob, and no scheme inference. Configure full prefixes including
  the scheme (`https://...`).
- Comparison is case-sensitive: `String.prototype.startsWith`
  compares the literal bytes. Allowlist entries should be written
  in lowercase (`https://...`) because that is what well-behaved
  LLMs emit. URL extraction itself is case-insensitive, so
  prompt-injected uppercase variants like
  `HTTPS://attacker.example/x` are still detected — but they will
  not match a lowercase allowlist entry. They fail validation and
  route through the retry → graceful abort flow (fail-secure).
- Trailing slashes matter for the prefix semantics. Listing
  `https://docs.example.com/` matches every path under that origin;
  listing `https://docs.example.com/api/` restricts to the `/api/`
  subtree.

A URL is allowed when **either** the own-repo check OR any
`allowed_url_prefixes` entry matches — both surfaces are union-ed,
not intersected.

### YAML samples

Minimum config (closed-world default — own-repo links only):

```yaml
privacy:
  allowed_url_prefixes: []
```

Single allowlisted external surface (e.g. internal docs):

```yaml
privacy:
  allowed_url_prefixes:
    - "https://docs.example.com/"
```

Multiple surfaces (org-wide approved references):

```yaml
privacy:
  allowed_url_prefixes:
    - "https://docs.example.com/"
    - "https://internal-runbooks.example.com/"
    - "https://owasp.org/www-project-top-ten/"
```

When `.review-agent.yml` uses `extends: org`, the
`allowed_url_prefixes` lists are **concatenated and de-duplicated**
across the org and repo configs (see
[`./extends.md`](./extends.md)). Operators get the org's policy
floor plus their repo's additions, never silently losing the org's
defaults.

---

## Failure modes

When the model emits a URL that fails both the own-repo check and
the allowlist, the runner follows the retry-then-abort sequence from
spec §7.3 #4:

1. **First attempt fails** — the runner captures the violation as
   a `SchemaValidationError` and retries `generateReview` once with
   a corrective prompt suffix asking the model to produce strictly
   valid output.
2. **Retry succeeds** — the review proceeds normally with the
   second attempt's output.
3. **Retry also fails** — the runner aborts the review gracefully.
   The returned `RunnerResult` has:

   - `comments: []` (no inline comments are posted),
   - `summary` set to a fixed operator-facing notice (one of the
     constants below — the rejected URL itself is **never** copied
     into this string),
   - `aborted: { reason, internalIssues }` where:
     - `reason` is `'url_allowlist'` when at least one issue was an
       allowlist violation, or `'schema_violation'` for any other
       second-attempt schema failure (broadcast mention, shell
       `curl http`, style-severity cap, etc.),
     - `internalIssues` carries the raw Zod issue list for the
       audit log / telemetry / debugger surfaces.

### Summary text the user sees

For a URL allowlist abort the summary the PR comment will display is:

> Review aborted: LLM produced output that violates the URL allowlist
> after one retry. See spec §7.3.

For any other schema-validation abort:

> Review aborted: LLM produced output that fails schema validation
> after one retry. See spec §7.3.

Both are constant strings; the rejected URL and any host hint stay
strictly out of user-facing output. Posting them verbatim would
re-open the very exfiltration channel the allowlist refine just
closed — a URL such as
`https://attacker.example/leak?token=...` carries the leaked secret
in its query string. The full URL is still available to the operator
through `RunnerResult.aborted.internalIssues` (audit log / telemetry
only) and the per-issue Zod `error.message` format below.

### Diagnostic error message format

`internalIssues[i].message` for an allowlist failure has the shape:

> `URL not in allowlist: <url> (expected host '<host>' or a configured allowed_url_prefixes entry)`

The host segment is the value passed in `ReviewJob.prRepo.host`. This
message is meant for operators reading the audit log when triaging a
recurring abort; do **not** echo it into any operator-visible PR
comment or stdout that adopters can scrape.

---

## Related docs

- [`./extends.md`](./extends.md) — how org and repo
  `allowed_url_prefixes` merge.
- [`../security/audit.md`](../security/audit.md) — STRIDE walkthrough
  that motivates the closed-world default.
- [`../specs/review-agent-spec.md`](../specs/review-agent-spec.md)
  §7.3 #4 — spec authority for the URL allowlist requirement.
