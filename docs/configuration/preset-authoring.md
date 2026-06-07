# Preset authoring guide

A **preset** is a `.review-agent.yml`-compatible YAML file that provides a
reusable base configuration. Consumers extend a preset with `extends:
<preset-name>` and override only the keys they need.

This guide covers:

1. [How bundled presets work](#1-how-bundled-presets-work)
2. [Writing your own preset](#2-writing-your-own-preset)
3. [Extending a preset](#3-extending-a-preset)
4. [Publishing and consuming third-party presets](#4-publishing-and-consuming-third-party-presets) _(stub — see #154)_

For the `extends: org` mechanism (org-wide central config), see
[extends.md](./extends.md) — it is a separate feature from named presets.

---

## 1. How bundled presets work

Three first-party presets ship with review-agent. List them:

```bash
review-agent config presets list
```

| Preset | Intended use |
|---|---|
| `recommended` | Most repositories. Balanced defaults. |
| `strict` | Release branches, security-sensitive services. Higher thresholds. |
| `security-focused` | Dedicated security review. Maximises security/bug; suppresses style noise. |

These presets live in `packages/config/src/presets/`. Each is a plain
`.review-agent.yml`-shaped object registered in
`packages/config/src/preset-registry.ts`. The loader deep-merges your repo
config on top of the chosen preset at load time.

### Override semantics

| Field type | Behaviour when your config overlaps the preset |
|---|---|
| Scalar (`max_files`, `language`, `profile`, …) | Your config wins (last wins). |
| Object (`reviews.auto_review`, `cost`, `ruleset.*`, …) | Deep-merged — your keys win; unmatched preset keys are preserved. |
| Array (`path_filters`, `ignore_authors`, …) | **Replaced entirely** by your config. The preset array is discarded. |

Array replacement is intentional. Write the complete desired list when you
override an array field — you cannot append to a preset array in v0.3.
Append semantics (`_merge: append`) are planned for a future release.

---

## 2. Writing your own preset

Today presets are **file-based only**: a `.review-agent.yml` YAML file in your
repository. Consumers reference it by path.

```yaml
# .review-agent/presets/typescript-strict.yml
# A preset for TypeScript monorepos with strict style requirements.

# yaml-language-server: $schema=https://review-agent.dev/schema/v1.json

profile: assertive

reviews:
  max_files: 100
  max_diff_lines: 5000
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]
    - github-actions[bot]

ruleset:
  style:
    min_severity: minor    # surface style issues at minor+
  docs:
    enabled: false         # this repo has separate doc tooling

cost:
  max_usd_per_pr: 2.00

suggestions:
  enabled: true
  categories:
    - bug
    - security
    - performance
```

Guidelines:

- **One concern per preset.** `typescript-strict` should not also embed
  `pii-handling` rules — use skills for that. Preset composition via chaining
  (`extends: [base, overlay]`) is the right pattern.
- **Provide sensible defaults for every key you include.** Consumers expect the
  preset to be usable as-is, not a partial fragment requiring mandatory
  overrides.
- **Avoid `language:` in shared presets.** Language is almost always a per-repo
  choice; hard-coding it in a preset surprises consumers.
- **Document your preset.** Add a short comment block at the top explaining
  the intended audience and any opinionated defaults.

---

## 3. Extending a preset

### Extend a bundled preset

```yaml
# .review-agent.yml
extends: recommended

# Override specific keys on top of the preset:
reviews:
  max_files: 100
ruleset:
  style:
    enabled: false
```

### Extend a local file preset

```yaml
# .review-agent.yml
extends: .review-agent/presets/typescript-strict.yml

reviews:
  ignore_authors:
    - my-team-bot       # replaces the preset's ignore_authors list entirely
```

### Chain multiple presets (left-to-right, later wins)

```yaml
extends:
  - recommended
  - .review-agent/presets/typescript-strict.yml
```

### Extend `org` (separate mechanism)

```yaml
extends: org   # opt into org central config merge — cannot be chained
```

`extends: org` and named presets are separate mechanisms and cannot be combined
in a single `extends:` array. See
[extends.md](./extends.md#mixing-extends-org-and-presets).

---

## 4. Publishing and consuming third-party presets

> **This section is a stub.** npm-distributed preset packages
> (e.g. `@review-agent/preset-owasp`) require the package registry
> infrastructure being built in **issue #154** (npm publish workflow).
> Until #154 lands, presets are file-based only (local paths in the
> repository or fetched via the org config mechanism).
>
> Do not set `extends` to an npm package name in v0.3 — it will be
> interpreted as a file path and silently not found.

When #154 ships, the workflow will be:

**Authoring and publishing** (future):

```bash
# Package your preset directory
pnpm pack                          # creates preset-name-x.y.z.tgz
npm publish --access public        # publish to npm
```

**Consuming** (future):

```yaml
# .review-agent.yml
extends: "@acme/review-agent-preset-strict"
```

The resolver will distinguish npm package names (starting with `@` or matching
`^[a-z0-9-]+$` without a `/` or `.`) from local file paths. Track issue #154
for the timeline.

---

## See also

- [extends.md](./extends.md) — full `extends` semantics (org config + preset
  chaining + merge rules).
- [config-reference.md](./config-reference.md) — complete key reference.
- [skills.md](../getting-started/skills.md) — skill files for domain-specific
  review rules (complement presets).
