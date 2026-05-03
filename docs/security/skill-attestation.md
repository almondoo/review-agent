# Skill provenance and attestation

This document records the v1.0 decision on skill-provenance
attestation (cosign or equivalent) for npm-distributed skills.
Spec reference: §15.7.3 (bundled skills), §22 #15 (deferred to
v1.1+), v1.0 issue #51.

---

## Decision: closed as wontfix for v1.0/v1.1

`review-agent` ships skill-loader infrastructure (`packages/runner/src/skill-loader.ts`)
that supports skills referenced by relative path under
`.review-agent/skills/<name>/SKILL.md`. The current integrity check
is a YAML frontmatter validator + a body sanitiser (script-tag and
forbidden-fenced-language stripper) + a 50 KB size cap. There is
**no SHA-256 manifest check today** because no first-party
`@review-agent/skill-*` packages have been published.

Spec §22 #15 explicitly defers cosign attestation to v1.1 and asks
us to "re-evaluate based on contributor demand. Track in a roadmap
issue, not in the spec." This document is the resolution of that
tracking item.

**v1.0 outcome**: cosign attestation infrastructure is **not
implemented**. Issue #51 closed as wontfix. The decision is
revisited if and when the first first-party skill is published.

---

## Why wontfix at v1.0

Three concrete reasons:

1. **No users exist.** As of v1.0 there are zero first-party
   `@review-agent/skill-*` npm packages (per spec §22 #4, that
   decision is itself v1.0+). Implementing cosign verification
   today protects against a supply-chain attack on a package
   that doesn't exist. By the YAGNI rule in this repo's
   CLAUDE.md, that's a clear cut.

2. **The current threat model holds without it.** Skills loaded
   from a path inside the user's repo cannot be tampered with
   without write access to that repo (which itself is the
   attacker's primary goal). The skill-loader's script-stripping
   + size cap + frontmatter validator + the runner's
   untrusted-content wrapper + the injection detector cover the
   in-skill prompt-injection vector. See
   [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md)
   findings T-5 and E-3 for the full reasoning.

3. **Cosign carries operational cost.** Verification requires
   `cosign verify-blob` available in the operator's CI runner —
   which is not a guarantee on every CI provider, every Lambda
   image, or every self-hosted environment. We would need an
   `skills.verify_attestation: false` opt-out for environments
   without cosign, which means the security posture is
   per-deployment, not project-wide. That's an operator-confusion
   surface that's hard to justify against the zero-user benefit.

The v1.1 re-evaluation gate is: **the first first-party
`@review-agent/skill-*` package is approved for publication.**
At that point, cosign keyless signing in the publish workflow +
loader-side `cosign verify-blob` becomes load-bearing and we
revisit. Until then, this document records the decision and #51
stays closed.

---

## What we ship instead (v1.0 baseline)

The skill loader's existing defenses, all enforced unconditionally:

| Defense | Code reference | Spec reference |
|---|---|---|
| YAML frontmatter validator (Zod schema) | `packages/runner/src/skill-loader.ts` `SkillFrontmatterSchema` | §15.7.4 |
| 50 KB body size cap | `packages/runner/src/skill-loader.ts` `MAX_SKILL_BYTES` | §15.7.4 |
| `<script>` tag stripping | `stripScriptyContent` | §15.7.4 |
| Forbidden fenced-code stripping (bash / sh / shell / powershell / python) | `stripScriptyContent` | §15.7.4 |
| Untrusted-content wrapper around skill body in the system prompt | `packages/runner/src/prompts/untrusted.ts` | §6.4 |
| LLM-based injection detector classifies skill content if suspect | `packages/runner/src/security/injection-detector.ts` | §11 |
| Resolution restricted to relative paths under workspace root (no npm, no `@scope/...` resolution path active) | `defaultResolve` throws on `@`-prefixed names | §15.7.3 |

For the skill *content* itself — what the user puts in
`.review-agent/skills/<name>/SKILL.md` — the threat model treats
it as **untrusted operator-supplied input**, not as code. The
loader does not execute it; the LLM reads it inside the
untrusted-content wrapper. Tampering with the skill body lets the
attacker influence the LLM's narrative but not bypass the
deterministic post-processing (dedup, gitleaks, cost cap).

---

## Re-evaluation triggers for v1.1+

This document is updated and #51 is reopened as a real
implementation issue when **any** of the following happens:

- A first-party `@review-agent/skill-*` package is approved for
  publication. Cosign becomes load-bearing the moment the
  loader can resolve from npm.
- The community publishes a third-party `@review-agent/skill-*`
  ecosystem worth integrity-protecting. (Unlikely given the OSS
  no-contributions stance, but possible if a fork takes off.)
- A documented incident demonstrates the YAML / script-stripping
  defenses are insufficient against a real attacker. So far the
  red-team eval (`packages/eval/fixtures/red-team/`) does not
  surface any such bypass.

Until at least one of these triggers fires, the v1.0 wontfix
holds. The fingerprint dedup, gitleaks, cost cap, and
untrusted-content wrapper continue to provide defense in depth at
the runner level regardless of what the skill content says.

---

## Cross-references

- [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) — STRIDE walkthrough findings T-5 (Tampering — modified skill content) and E-3 (EoP — skill tells agent to skip review).
- [`../../packages/runner/src/skill-loader.ts`](../../packages/runner/src/skill-loader.ts) — current loader implementation.
- [`../../UPGRADING.md`](../../UPGRADING.md) — public API surface; the loader's `loadSkill`, `loadSkills`, `renderSkillsBlock`, `Skill`, `SkillFrontmatter`, `SkillFrontmatterSchema` exports are stable. Adding cosign verification later would extend (not break) this surface.
