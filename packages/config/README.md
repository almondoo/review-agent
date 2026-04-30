# @review-agent/config

`.review-agent.yml` schema (v1), loader, and JSON Schema generator.

## Exports

- `ConfigSchema` — Zod schema for `.review-agent.yml` v1 (per spec §10.1).
- `loadConfigFromYaml(yamlText)` — parses + validates a YAML string.
- `mergeWithEnv(config, env)` — applies env-var overrides per spec §10.2.
- `DEFAULT_CONFIG` — the resolved defaults (drafts: false; ignore_authors
  includes dependabot/renovate/github-actions per Q2/Q3 decisions).
- `generateJsonSchema()` — emits the public JSON Schema document.

## Defaults — v0.1 decisions

- `reviews.auto_review.drafts: false` (skip until ready_for_review)
- `reviews.ignore_authors: [dependabot[bot], renovate[bot], github-actions[bot]]`
- `incremental.enabled: true`
- `cost.max_usd_per_pr: 1.0`

## License

Apache-2.0
