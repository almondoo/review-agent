# Privacy

`.review-agent.yml`'s `privacy:` section controls what review-agent
will accept from the LLM into operator-visible output. It is the
operator-facing surface of the spec §7.3 / §7.4 hardening that keeps
prompt-injected models from exfiltrating PR content through review
comments.

Today the section ships three keys:

- `allowed_url_prefixes` — closed-world allowlist for any URL the LLM
  emits in `summary` / `body` / `suggestion` (spec §7.3 #4). Implemented
  in `#85`.
- `deny_paths` — additional repo paths the runner must refuse from
  the LLM's read / glob / grep tools and from the auto-fetch
  companion-file pipeline, on top of the built-in deny list (spec
  §7.4 "extend, not relax"). Implemented in `#86`.
- `redact_patterns` — additional secret regex patterns lifted into
  the gitleaks ruleset and the in-process scanner, on top of the
  built-in detectors. Same "extend, not relax" semantic — operators
  add detectors, they can't remove built-ins (spec §7.4). Implemented
  in `#87`.

Spec reference: §7.3 (prompt-injection defense, #4 URL allowlist),
§7.4 (tool-surface containment), §7.7 (output validation schema).

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

## `deny_paths`

`privacy.deny_paths` is the operator-extensible deny list that the
runner applies to every workspace-touching tool call the LLM (or the
agent's own auto-fetch pipeline) makes during a review. It is the
spec §7.4 surface for "the LLM must never read these files no matter
what the diff or the prompt-injected payload asks for."

### Scope: where it is enforced

The deny list runs at the dispatcher layer in
`packages/runner/src/tools.ts` and applies to **all four** workspace
read paths:

| Tool                         | Behavior on deny match                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `read_file`                  | Hard refuse — throws `ToolDispatchRefusedError`. The error message includes only the path the LLM supplied (already known to it) and never reveals which deny entry — built-in vs operator — matched. |
| `glob`                       | Silent skip — denied entries are dropped from the result list. No exception, no marker.                                 |
| `grep`                       | Silent skip during the walk; an explicit `path:` scope that lands on a denied entry is a hard refuse (same as read_file). |
| auto-fetch (companion files) | Silent skip — same `read_file` underneath; refusals are swallowed and the companion is simply not included in the prompt. |

`glob` / `grep` / auto-fetch use silent skip rather than an exception
on purpose. They are exploratory tools, and surfacing a refusal per
hit would teach a prompt-injected LLM to enumerate the deny list by
asking for files until it sees an error. Silent skip keeps the deny
list opaque from the LLM's vantage point.

### Closed-world default — the built-in list always applies

The dispatcher unions `privacy.deny_paths` with a built-in
`DENY_PATTERNS` list. The union is **OR-only**: there is no API
surface (negation, exclusion, allowlist-of-deny) that lets an
operator remove an entry from `DENY_PATTERNS`. This is the
spec §7.4 "extend, not relax" rule, enforced structurally rather
than by convention.

The built-in list, source of truth `packages/runner/src/tools.ts:19-28`:

| Pattern (regex)                       | What it denies                                                                | Case      |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `(^\|/)\.env(\..*)?$`                 | `.env`, `.env.local`, `.env.production`, …                                    | sensitive |
| `(^\|/)secrets?(/\|$)`                | `secret/`, `secrets/`, and anything under them                                | **insensitive** |
| `(^\|/)private(/\|$)`                 | `private/` and anything under it                                              | **insensitive** |
| `(^\|/)credentials?(/\|$)`            | `credential/`, `credentials/`, and anything under them                        | **insensitive** |
| `\.(key\|pem\|p12\|pfx)$`             | `*.key`, `*.pem`, `*.p12`, `*.pfx`                                            | **insensitive** |
| `credentials.*\.json$`                | `credentials.json`, `credentials.prod.json`, …                                | **insensitive** |
| `service-account.*\.json$`            | `service-account.json`, `service-account-key.json`, …                         | **insensitive** |
| `^\.aws/credentials$`                 | The literal `.aws/credentials` at workspace root                              | sensitive |

If a path is denied by *both* the built-in list and an operator
entry, only one `ToolDispatchRefusedError` fires — the dispatcher
does not double-throw. The refusal message includes the path but not
which layer matched, so operators cannot inadvertently leak the
internal deny shape through error replay.

### Glob syntax

User entries are parsed with `globToRegExp` from `@review-agent/core`.
The supported syntax is a small subset of glob:

- `*` matches any sequence of characters **except** the path
  separator `/`.
- `**` matches any sequence including `/` (i.e. recursive).
- `**/` is the "zero or more segments, then a slash" wildcard, so
  `compliance/**/policy.txt` matches both `compliance/policy.txt`
  and `compliance/a/b/policy.txt`.
- Every other character is matched literally.
- Brace expansion (`{a,b}`), `?`, and character classes (`[...]`) are
  **not** supported. These characters are escaped as literals by
  `globToRegExp`, so a pattern like `src/[abc]/*.ts` matches only the
  literal string `src/[abc]/...` — not the character class you may
  have intended. Stick to `*` (within-segment) and `**` (across-segment)
  for the documented semantics.

Each compiled pattern is anchored — equivalent to wrapping the
generated regex in `^...$`. This means the entry has to match the
entire path-relative-to-workspace string, not a substring.

#### Anchoring gotcha: `compliance/**` vs `compliance`

An anchored regex changes how partial matches behave, and it is the
single most common source of "I wrote a deny entry but my file still
got read" reports. Pin the exact behavior in your head with these
two examples — both pinned in
`packages/runner/src/tools.test.ts` ("anchor regression" + recursive
glob tests).

| Entry         | Matches                                       | Does NOT match                                                            |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `compliance`  | the literal entry `compliance` (rare — a top-level file with no extension named exactly `compliance`) | `compliance/policy.txt`, `compliance/sub/foo.txt` |
| `compliance/*`| `compliance/policy.txt` (one level deep)      | `compliance` itself; `compliance/sub/foo.txt`                              |
| `compliance/**`| `compliance/policy.txt`, `compliance/sub/foo.txt`, anything below | `compliance` (the bare top-level entry; rare and harmless) |

In practice: **write `compliance/**` if you mean "everything under
compliance/".** Writing `compliance` alone is almost never what an
operator intends.

### Case-sensitivity

This is the second most common source of fail-open surprise, because
the built-ins and the operator extensions follow **different** rules.

- **Built-in entries** preserve the `/i` flag on the patterns in
  `tools.ts` (see the table above): `secrets/`, `private/`,
  `credentials/`, and the `.key`/`.pem`/`.p12`/`.pfx` extension
  matchers are **case-insensitive**, so `Secrets/db.json`,
  `PRIVATE/`, etc. are blocked too.
- **Operator entries** go through `globToRegExp`, which produces a
  case-sensitive `RegExp`. An entry `compliance/**` will NOT block
  `Compliance/policy.txt`.

This split is intentional: the built-in case-insensitive flags
guarantee fail-secure on case-insensitive filesystems (macOS APFS,
Windows NTFS) for the most common high-risk paths, while the
operator gets predictable literal matching for repo-specific globs.

**Practical advice** for repos that may be checked out on a
case-insensitive filesystem (anyone doing local development on
macOS, anyone running the CLI on a developer laptop, anyone running
GHA on Windows runners): write **both** casings in
`deny_paths` if you care about case folding, e.g.

```yaml
privacy:
  deny_paths:
    - "Compliance/**"
    - "compliance/**"
    - "PRIVATE-CUSTOMER-DATA/**"
    - "private-customer-data/**"
```

A future major release may add a `case_insensitive: true` knob;
right now the explicit-pair workaround is the supported path. The
behavior is pinned by `tools.test.ts`
"built-in case-insensitive deny still applies when operator pattern is case-sensitive"
+ "user pattern compiled by globToRegExp is case-sensitive by default".

### Known limitations

Two limitations are intentional in v1.x and pinned with regression
tests rather than fixed at the dispatcher level. Operators who land
in either case should add explicit deny entries that match their
filesystem's actual byte layout.

1. **Path separator: POSIX-only forward slash.** The deny gate
   matches the workspace-relative POSIX-style string. A literal
   backslash in a filename (which is rare in practice but legal on
   Linux) is treated as part of the filename, not a path separator.
   A file literally named `compliance\foo.txt` would slip past
   `compliance/**` on a Linux runner. GitHub Actions runs Linux by
   default; we do **not** support Windows runners in v1.x.
   Pinned by `tools.test.ts` "POSIX runner: backslash-as-separator
   is NOT normalized".
2. **Unicode: no implicit normalization.** Both the deny pattern and
   the candidate path are matched at the JavaScript-codepoint level.
   `privé/**` written with U+00E9 (single codepoint, NFC) does NOT
   block a path stored as `e + U+0301` (combining acute, NFD).
   macOS APFS preserves whichever form the originating tool wrote;
   git on Linux preserves bytes; HFS+ and some encoding pipelines
   normalize to NFD. If your repo paths contain non-ASCII, write
   both NFC and NFD forms in `deny_paths` and verify the test
   fixture `tools.test.ts` "Unicode normalization: NFC pattern does
   NOT match NFD path" against your actual checkout.

### YAML samples

Closed-world baseline — only the built-in deny list is active:

```yaml
privacy:
  deny_paths: []
```

Add a single recursive deny on top of the built-ins:

```yaml
privacy:
  deny_paths:
    - "compliance/**"
```

Multiple operator entries (repo-specific sensitive folders + a
single-file targeted deny):

```yaml
privacy:
  deny_paths:
    - "compliance/**"
    - "legal-confidential/**"
    - "customer-data-exports/*.csv"
    - "infra/terraform.tfstate"
```

It is safe — and harmless — to write an operator entry that overlaps
a built-in. `deny_paths: ["secrets/**"]` simply duplicates the
built-in `secrets/` rule; the dispatcher de-duplicates the resulting
refusal and behaves identically with or without the operator entry.

When `.review-agent.yml` uses `extends: org`, the `deny_paths` lists
are **concatenated and de-duplicated** across the org and repo
configs (same merge semantics as `allowed_url_prefixes`; see
[`./extends.md`](./extends.md)). Operators get the org's deny floor
plus their repo's additions, never silently losing the org's
baseline.

---

## `redact_patterns`

`privacy.redact_patterns` is the operator-extensible secret-pattern
list that runs on top of gitleaks' built-in ruleset (spec §7.4). It
exists for the case where an organisation has its own token shape —
e.g. `INTERNAL-TOKEN-<16 alnum>`, an in-house webhook secret prefix,
a customer-identifier format that must never appear in code review
output — that gitleaks' default detectors don't know about.

Each entry is a regular-expression string. The runner lifts every
entry into a gitleaks `[[rules]]` block (`id = "custom-<index>"`) and
also compiles it for the in-process `quickScanContent` fallback. Both
the diff pre-scan (before any byte is sent to the LLM) and the
output post-scan (before any comment is posted to the PR) run the
operator patterns in the same pass as the built-ins.

### Scope: where it is enforced

The pattern set runs at two scan boundaries inside `runReview`
(`packages/runner/src/agent.ts`):

| Boundary | What it scans | Behaviour on match |
| --- | --- | --- |
| Diff pre-scan | `job.diffText` before the LLM call. | A custom-N hit is `tags: ["high"]` — the runner aborts the review with `SecretLeakAbortedError(phase='diff')` BEFORE invoking the provider. The LLM never sees the bytes. |
| Output post-scan | `summary` + every kept comment body after dedup + confidence filter. | A custom-N hit triggers `SecretLeakAbortedError(phase='output')`, mirroring the built-in-rule abort path. No PR comment is posted. |

When `shouldAbortReview` does not fire (e.g. a future relaxation that
lowers a specific custom rule to a non-`high` tag, or a build-in
medium-confidence finding alongside the custom hit), `applyRedactions`
substitutes the matched substring with `[REDACTED:custom-<index>]`.

### Closed-world default — built-in rules always apply

The runner emits the gitleaks config fragment with
`[extend] useDefault = true`, which is gitleaks' own knob for
"layer my rules on top of the default ruleset, don't replace it."
Without that directive `--config` REPLACES the defaults, and the
built-in AWS / GitHub / Anthropic / OpenAI / PEM detectors would
silently disappear — the exact "extend, not relax" failure §7.4
forbids. The in-process `quickScanContent` fallback follows the
same union semantic: built-ins always run, custom patterns are
appended.

Operators cannot remove a built-in rule through `redact_patterns`.
The list is one-way additive by design.

### Redaction format

Findings carry a stable `ruleId` so operators can grep PR-comment
redactions back to the source config entry:

| Source | `ruleId` shape | Example placeholder |
| --- | --- | --- |
| Built-in `quickScanContent` rule | Stable string (`aws-access-key`, `github-pat`, `private-key-block`, ...) | `[REDACTED:aws-access-key]` |
| Built-in gitleaks rule (subprocess) | gitleaks' own rule id | `[REDACTED:aws-access-token]` (rule-id format follows gitleaks output verbatim — no `gitleaks-` prefix) |
| Operator pattern (this section) | `custom-<index>`, where `<index>` is the 0-based position in `privacy.redact_patterns` after the org+repo merge | `[REDACTED:custom-0]`, `[REDACTED:custom-1]` |

The `custom-<index>` form is the runtime contract pinned by
`gitleaks.test.ts` "produces `[REDACTED:custom-N]` tokens" and
`agent.test.ts` "redacts a custom-pattern hit in the LLM output".
Order is the post-merge insertion order — after `extends: org`, org
entries come first, then repo entries (de-duplicated), so a custom
pattern's index is stable for a given config pair.

### YAML-load validation

Each entry is validated by the Zod schema at config-load time, via
`isValidRegex` in `@review-agent/core`. The check rejects three
shapes up front so the operator sees the failure before any review
runs:

- Empty strings (`""`).
- Strings containing a NUL byte (0x00).
- Strings that `new RegExp(pattern)` cannot compile (unbalanced
  bracket `[a-z`, lone quantifier `*invalid`, malformed group
  `(unclosed`, …).

A pattern that survives `isValidRegex` is guaranteed to compile
under **V8's** regex engine — which is the engine the in-process
`quickScanContent` uses. The gitleaks subprocess runs Go's RE2,
which is a strict subset of V8; see the next section.

### RE2 subset caveat — gitleaks rejects some V8-valid patterns

gitleaks compiles every rule with Go's `regexp` package, which uses
RE2. RE2 deliberately omits regex features that allow exponential
backtracking, and that set is **not** a subset of what V8 accepts.
The most common culprits are:

| Feature | V8 (config-load check) | RE2 (gitleaks runtime) |
| --- | --- | --- |
| Backreferences (`\1`, `\k<name>`) | accepted | **rejected** |
| Lookbehind (`(?<=...)`, `(?<!...)`) | accepted | **rejected** |
| Lookahead (`(?=...)`, `(?!...)`) | accepted | **rejected** |
| Possessive quantifiers (`a*+`) | parsed as literal | **rejected** when surfaced |
| Unicode property classes (`\p{Letter}`) | accepted | accepted (with `(?u)` or `--config` flag — varies by gitleaks version) |
| Inline modifiers (`(?i)`, `(?s)`, `(?m)`) | partial | accepted |

A pattern that passes `isValidRegex` but exercises one of the
rejected features will compile fine in the in-process scan and then
crash `scanWorkspaceWithGitleaks` at config-load time. The runner
catches that error, sniffs stderr for `error parsing regexp` /
`cannot compile` / `invalid or unsupported perl syntax`, and
re-throws with a docs pointer:

> Hint: gitleaks compiles patterns with Go's RE2 engine, which is a
> strict subset of JavaScript regex — backreferences (\1), lookbehind
> ((?<=…)), and lookahead ((?=…)) are NOT supported. Adjust the
> offending privacy.redact_patterns entry. See
> docs/configuration/privacy.md for the RE2 constraints.

**Operator guidance**: keep entries inside the RE2 subset. The
common workarounds:

- Replace `(?<=PREFIX)TARGET` (lookbehind) with `(?:PREFIX)(TARGET)`
  and use the capture group when post-processing finds it. For
  redaction purposes the whole match is the secret anyway — there is
  rarely a reason to lookbehind in the first place.
- Replace `TARGET(?=SUFFIX)` (lookahead) with `TARGET(?:SUFFIX)` and
  redact the longer match. The placeholder `[REDACTED:custom-N]`
  covers both the secret and the suffix uniformly.
- Replace `(KEY)=\1\1` (backreference) with the literal expansion
  you actually need to detect. RE2's design assumption is that
  every match runs in linear time; backreferences break that and
  are intentionally absent.

If you cannot express the rule without RE2-unsupported features,
file an issue — the right fix is usually a different rule shape,
not a regex-engine swap.

### TOML serialisation caveat — `'''` cannot appear in a pattern

The runner emits each operator pattern into the gitleaks config
TOML as a **multi-line literal string**:

```toml
[[rules]]
id = "custom-0"
description = "review-agent privacy.redact_patterns[0]"
regex = '''<your pattern verbatim>'''
tags = ["high"]
```

Multi-line literals pass every byte through unchanged — no
backslash escape, no quote escape, no `$` escape, no newline
escape. The single sequence a TOML multi-line literal cannot
contain is its own terminator, `'''` (three consecutive single
quotes). The runner detects this shape at lift time and throws a
clear error rather than silently truncating the regex:

> privacy.redact_patterns[N] contains the TOML multi-line literal
> terminator (''') — gitleaks config syntax cannot represent it.
> Restructure the pattern to avoid three consecutive single quotes.

This is vanishingly rare in real regex sources (single quotes are
almost never repeated in a secret-pattern shape), but documented so
the rejection isn't a surprise.

### ReDoS — pattern design is the operator's responsibility

`isValidRegex` ensures every entry compiles. It does **not** reject
patterns that are prone to catastrophic backtracking — the classic
`(a+)+` shape compiles fine and will pin a CPU on a long enough
adversarial input. The runner provides two structural mitigations:

- The diff pre-scan operates on `job.diffText`, whose size is bounded
  by `reviews.max_diff_lines` (default 3000 lines).
- The output post-scan operates on the LLM's response, whose length
  is bounded by the provider's token budget.

These caps make a malicious-pattern × adversarial-input scenario
finite but not zero-cost. Operators are responsible for the
algorithmic safety of every pattern they add. The standard rules of
thumb:

- Anchor and bound quantifiers (`AKIA[0-9A-Z]{16}` rather than
  `AKIA[0-9A-Z]+`).
- Avoid nested or overlapping repetitions (`(a+)+`, `(a|a)+`,
  `(.*).*`).
- Test pathological inputs against the pattern in a Node REPL before
  shipping — if `'a'.repeat(50)` plus one mismatch takes more than a
  few milliseconds, the pattern is likely vulnerable.

A future hardening pass may add a per-scan execution timeout (via
`re2` or an equivalent linear-time engine wrapper). For now the
operator owns the trade-off.

### YAML samples

Closed-world baseline — only built-in detectors active:

```yaml
privacy:
  redact_patterns: []
```

Single operator-internal token shape:

```yaml
privacy:
  redact_patterns:
    - "INTERNAL-TOKEN-[A-Z0-9]{16}"
```

Multiple shapes, including an entry that intentionally overlaps a
built-in detector (harmless — both rules fire and the dedup in
`applyRedactions` collapses to a single placeholder per match):

```yaml
privacy:
  redact_patterns:
    - "INTERNAL-TOKEN-[A-Z0-9]{16}"
    - "acme_webhook_[A-Za-z0-9]{32}"
    - "AKIA[0-9A-Z]{16}"          # overlaps built-in aws-access-key
    - "CUSTOMER-[0-9]{10}-[A-F]{4}"
```

When `.review-agent.yml` uses `extends: org`, the
`redact_patterns` lists are **concatenated and de-duplicated**
across the org and repo configs (same merge semantics as
`allowed_url_prefixes` / `deny_paths`; see
[`./extends.md`](./extends.md)). De-dup is by exact string match,
so two patterns expressing the same shape with different syntax
(`AKIA[0-9A-Z]{16}` vs `AKIA[A-Z0-9]{16}`) coexist with separate
`custom-N` ids.

### Known limitations

These limitations are intentional in v1.x. Operators who hit them
should structure around them rather than working through the
runner internals.

1. **Regex string only — full gitleaks rule syntax is not exposed.**
   gitleaks' native config supports per-rule entropy thresholds
   (`entropy = 4.0`), per-rule allowlists, path-scope restrictions
   (`path = "..."`), and secret-group selection (`secretGroup = 2`).
   The runner deliberately exposes only the `regex` field — every
   other field would have to be validated for prompt-injection
   resistance and audited for its interaction with the in-process
   fallback. Patterns that need those features should be promoted
   to gitleaks built-ins (file a PR) rather than added to operator
   config.
2. **No per-pattern timeout.** A ReDoS-prone pattern can in principle
   pin the scanner for an adversarial diff or LLM response (see the
   ReDoS section above). The size caps on `diffText` and LLM output
   bound the worst case; an explicit `re2` wrapper is on the
   roadmap.
3. **`tags = ["high"]` is fixed.** Every operator pattern is treated
   as a high-confidence detector — any match aborts the review the
   same way a built-in `aws-access-key` match does. There is no knob
   yet to mark a custom pattern as `medium` (would route through
   `applyRedactions` without abort). If you need that, file an
   issue; the simplest path forward is a dedicated `tags:` field
   on each list entry once the schema grows beyond bare strings.
4. **No `'''` in regex sources.** The TOML multi-line literal
   terminator cannot appear inside the pattern. The runner rejects
   such patterns at lift time. See the TOML caveat above.

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
  `allowed_url_prefixes` / `deny_paths` / `redact_patterns` lists merge.
- [`../security/audit.md`](../security/audit.md) — STRIDE walkthrough
  that motivates the closed-world default.
- [`../specs/review-agent-spec.md`](../specs/review-agent-spec.md)
  §7.3 #4 — spec authority for the URL allowlist requirement;
  §7.4 'Secret scanning' / Path-based exclusions — tool-surface
  containment ("extend, not relax").
