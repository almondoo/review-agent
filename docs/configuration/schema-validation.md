# Schema Validation & Editor Completion

review-agent ships a JSON Schema for `.review-agent.yml` that enables real-time
editor completion and CI-runnable validation without a live server.

## Schema URL

```
https://review-agent.dev/schema/v1.json
```

The schema is versioned via its `$id` field (`"$id": "https://review-agent.dev/schema/v1.json"`).
The committed copy lives at `schema/v1.json` in this repository and is regenerated from the
Zod source via `pnpm --filter @review-agent/config schema:generate`.

## Editor completion (VS Code & any YAML Language Server editor)

Add the following directive as the **first line** of your `.review-agent.yml`:

```yaml
# yaml-language-server: $schema=https://review-agent.dev/schema/v1.json
language: en-US
profile: chill
```

This wires the YAML Language Server (used by VS Code's
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml),
IntelliJ, Neovim via yaml-language-server, and others) to the published schema.
You get:

- Key completion for all top-level sections (`reviews`, `ruleset`, `provider`, etc.).
- Enum completion for string fields (`profile`, `language`, `provider.type`, `ruleset.<cat>.min_severity`).
- Hover documentation derived from the schema descriptions.
- Inline error markers on unknown keys or wrong-typed values.

### VS Code workspace setting (alternative)

If you prefer to wire the schema globally for all `.review-agent.yml` files in your
workspace, add this to `.vscode/settings.json`:

```json
{
  "yaml.schemas": {
    "https://review-agent.dev/schema/v1.json": ".review-agent.yml"
  }
}
```

## CI validation

The `review-agent config validate` command reads a `.review-agent.yml` and exits
non-zero on any schema violation. It is usable in CI without a live server or
database connection.

```
review-agent config validate [--config <path>]
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Config is valid. |
| 1 | Config is invalid (schema error or YAML parse error). |
| 2 | Tool error (file not found, read permission denied, etc.). |

### Example output for an invalid config

```
Invalid .review-agent.yml:
  ruleset.security.min_severity:1 — Invalid enum value. Expected 'critical' | 'major' | 'minor' | 'info', received 'blocker'
  reviews.max_steps:3 — Number must be less than or equal to 50
```

Each issue includes the YAML key path and a human-readable description. No raw
Zod or AJV stack dumps are emitted.

### GitHub Actions example

```yaml
- name: Validate review-agent config
  run: review-agent config validate --config .review-agent.yml
```

## Schema completeness

The schema covers all configuration keys introduced across releases:

| Section | Keys |
|---------|------|
| Top-level | `extends`, `language`, `profile`, `provider`, `reviews`, `cost`, `privacy`, `repo`, `skills`, `incremental`, `coordination`, `server`, `codecommit`, `ruleset` |
| `reviews` | `auto_review`, `path_filters`, `path_instructions`, `max_files`, `max_diff_lines`, `ignore_authors`, `min_confidence`, `request_changes_on`, `max_steps` |
| `reviews.auto_review` | `enabled`, `drafts`, `base_branches`, `paths` |
| `reviews.path_instructions[]` | `path`, `instructions`, `auto_fetch` |
| `ruleset.<category>` | `enabled`, `min_severity` (categories: `bug`, `security`, `performance`, `maintainability`, `style`, `docs`, `test`) |
| `provider` | `type`, `model`, `fallback_models`, `base_url`, `region`, `azure_deployment`, `vertex_project_id`, `anthropic_cache_control` |
| `cost` | `max_usd_per_pr`, `hard_stop`, `daily_cap_usd` |
| `privacy` | `redact_patterns`, `deny_paths`, `allowed_url_prefixes` |
| `coordination` | `other_bots`, `other_bots_logins` |
| `server` | `workspace_strategy` |
| `codecommit` | `approvalState` |

Unknown keys are rejected at validation time — a typo like `reveiws:` fails immediately
with a clear error instead of silently doing nothing.

## Regenerating the committed schema

When the Zod schema in `packages/config/src/schema.ts` changes, regenerate the committed
JSON Schema file by running:

```bash
pnpm build                                       # rebuild config package first
pnpm --filter @review-agent/config schema:generate
```

The generated file is automatically formatted by Biome. Commit the updated `schema/v1.json`.
