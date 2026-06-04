# Migrating from DB-`systemPrompt`-only deployments

This note is for operators who configured review behavior **exclusively** via
a `systemPrompt` column in the Postgres `installations` table (the v0.x
approach) and want to migrate to file-based, version-controlled configuration.

## Background

In v0.x, the only way to customize review behavior was to set a `systemPrompt`
value in the database for each installation. This value was injected verbatim
into the LLM's system prompt on every review.

Since issue #146 (and the earlier `.review-agent.yml` v1 schema in #6/#27/#88),
the committed YAML file is the primary source of truth. The `systemPrompt`
database field is now a **last-resort override** that sits below all YAML
layers in the precedence stack:

```
PR comment commands  (highest)
  └── repo .review-agent.yml
        └── org-central review-agent.yml
              └── env vars (REVIEW_AGENT_*)
                    └── DB systemPrompt (last resort)
                          └── built-in defaults  (lowest)
```

## Migration steps

### 1. Export your current systemPrompt

Connect to your Postgres instance and extract the current system prompt text
for each installation:

```sql
SELECT installation_id, system_prompt
FROM installations
WHERE system_prompt IS NOT NULL AND system_prompt <> '';
```

### 2. Map prompt content to YAML keys

Review the exported text and identify which knobs it was setting.
Common patterns and their YAML equivalents:

| DB `systemPrompt` content | `.review-agent.yml` key |
|---|---|
| "Respond in Japanese" | `language: ja-JP` |
| "Be strict / blocking" | `profile: assertive` |
| "Ignore dist/ and *.lock" | `reviews.path_filters: ['!dist/**', '!**/*.lock']` |
| "Use gpt-4o" | `provider: { type: openai, model: gpt-4o }` |
| "Don't review Dependabot PRs" | `reviews.ignore_authors: [dependabot[bot]]` |
| Custom domain rules / guidelines | Create a [skill file](../getting-started/) |

For arbitrary free-text instructions with no direct YAML equivalent, the
recommended approach is a **skill file**:

```yaml
# .review-agent/skills/org-guidelines.md
---
name: org-guidelines
description: Organization-specific review guidelines
globs: ["**/*"]
---

[Paste your previous DB systemPrompt content here]
```

Then reference it in `.review-agent.yml`:

```yaml
skills:
  - ./.review-agent/skills/org-guidelines
```

### 3. Commit `.review-agent.yml` to the repository

```bash
# Create the file
cat > .review-agent.yml << 'EOF'
language: ja-JP
profile: assertive
reviews:
  path_filters:
    - "!dist/**"
    - "!**/*.lock"
skills:
  - ./.review-agent/skills/org-guidelines
EOF

git add .review-agent.yml
git commit -m "chore: migrate review-agent config from DB to YAML"
```

### 4. (Optional) Clear the DB systemPrompt

Once your YAML-based config is in place and verified, you can clear the
legacy `systemPrompt` column. The YAML layers take full precedence when
present, so leaving the DB value in place is safe — it will simply never
be reached. Clearing it is a hygiene step:

```sql
UPDATE installations
SET system_prompt = NULL
WHERE installation_id IN (<your-ids>);
```

### 5. Verify effective-config resolution

After deploying, trigger a test PR review and check the `onConfigResolution`
log (if your deployment wires the hook):

```json
{
  "primarySource": "repo-yaml",
  "orgYamlLoaded": false,
  "envApplied": false,
  "sections": {
    "language": "repo-yaml",
    "profile": "repo-yaml",
    ...
  }
}
```

`primarySource: "repo-yaml"` confirms the YAML file is in control.

## Back-compat guarantee

Existing deployments that have **not** committed a `.review-agent.yml` are
unaffected. The resolver falls back gracefully:

- No repo YAML, no org YAML → built-in defaults (and DB `systemPrompt` if
  your server wiring still injects it).
- `primarySource` in the log will be `"default"`.

No code change or migration is required for deployments that want to keep
using the DB field as their only customization surface — but that pattern
is deprecated and will not receive new knobs.
