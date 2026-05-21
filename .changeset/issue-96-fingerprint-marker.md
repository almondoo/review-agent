---
'@review-agent/core': minor
'@review-agent/platform-github': minor
'@review-agent/platform-codecommit': minor
'@review-agent/runner': patch
---

#96 — Embed `<!-- fingerprint:<fp> -->` marker in posted PR comments.

Both VCS adapters (`postReview` in `@review-agent/platform-github` and
`@review-agent/platform-codecommit`) now append a hidden HTML-comment marker
carrying the 16-char `fingerprint()` to every inline comment they post. This
unblocks the marker (a) path of #95's `/feedback` resolver — the operator can
now reply `/feedback accept` (no argument) on any bot inline comment and the
worker recovers the fingerprint by reading the parent body.

- `@review-agent/core`: `appendFingerprintMarker(body, fp)` (idempotent
  writer-side helper) and `extractFingerprintFromComment(body)` (reader-side
  helper, 8–16 hex tolerant for #95's `fp_prefix` reuse).
- `@review-agent/runner`: `extractFingerprintMarker` in the feedback
  fingerprint resolver is now a thin alias for the new core helper; behavior
  is unchanged for existing callers.
- Back-compat: `appendFingerprintMarker` is idempotent and does not duplicate
  markers; pre-#96 posted comments keep working via #95's `fp_prefix` fallback.
