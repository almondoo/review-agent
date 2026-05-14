# Pre-v1.0 security review approach

PRD §12.1 v1.0 requires "third-party security audit, or equivalent
threat-model review" before tagging v1.0. This document records
which option `review-agent` chose and why, plus the deliverable
location.

Spec reference: PRD §12.1 v1.0, v1.0 issue #44.

---

## Decision: option (b) — internal threat-model walkthrough

`review-agent` is a personal project published as OSS for
reference (not accepting external contributions). Commissioning a
paid third-party security audit (option a) is disproportionate to
the maintainer's scope: the cost ($25k–$80k for a focused
engagement) exceeds the project's lifetime budget by orders of
magnitude, and there is no operator paying for hosted access to
amortise it.

We therefore selected **option (b): a structured internal
threat-model walkthrough** against the STRIDE framework, with one
required gating: at least one reviewer outside the maintainer's
direct affiliation must sign off.

This matches the PRD's explicit acknowledgement that option (b) is
acceptable. We document the trade-off honestly so adopters
understand the depth of review:

> Adopters should treat `review-agent` as having had a structured
> internal review against STRIDE, **not** an independent paid
> audit. If your deployment requires the latter (e.g. a regulated
> environment), commission your own engagement covering at least
> the seven attack categories in
> [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md).

---

## Procedure

1. **STRIDE walkthrough**: each of the six STRIDE categories
   (Spoofing, Tampering, Repudiation, Information disclosure,
   Denial of service, Elevation of privilege) is walked through
   against the data-flow surfaces in `SECURITY.md` "Threat model"
   plus the post-v0.3 surfaces (BYOK, multi-tenant RLS, server
   webhook receiver, audit log). Each category produces a finding
   list.
2. **Findings triage**: each finding is rated `informational`,
   `low`, `medium`, `high`, or `critical`. `high` and `critical`
   block v1.0 tagging until fixed; `medium` and below are tracked
   in the issue list as v1.x follow-up.
3. **Unaffiliated reviewer sign-off** (amended 2026-05-15 — see
   "Procedure amendment" section below). At least one independent
   reviewer reads the walkthrough, challenges the assumptions, and
   either signs off or flags missing surfaces. The reviewer's
   affiliation, name (or persona for AI agents), and the date of
   sign-off are recorded at the bottom of
   `threat-model-review-2026-05.md`.

   For personal-OSS-scope projects (no external contributors,
   no hosted-tenancy operator paying for assurance) the original
   "external human reviewer" requirement is structurally
   unsatisfiable. The amended acceptable forms are:

   - **(i) Unaffiliated human reviewer** (preferred when
     available): a peer engineer, security-focused collaborator,
     or hired consultant for a scoped review.
   - **(ii) Multi-AI-agent independent review**: three
     persona-driven AI agents (security researcher / SRE /
     application developer) each read the walkthrough and
     source, challenge the assumptions, and produce a verdict
     (`pass` / `pass with findings` / `fail`). All three rows
     must reach `pass` or `pass with findings` for the gate to
     close, and **the AI nature must be fully disclosed** in
     the Sign-off table.

   Self-attestation by the maintainer alone (without (i) or
   (ii)) does **not** close the gate.
4. **SECURITY.md update**: any new attack surface or mitigation
   discovered during the walkthrough is reflected in
   [`../../SECURITY.md`](../../SECURITY.md) so the published
   threat model stays in sync.
5. **Public summary**: a redacted summary of findings + mitigations
   is published under `docs/security/`. Sensitive details (e.g.
   detection-bypass specifics) may be omitted.
6. **Annual cadence**: the walkthrough is repeated yearly as part
   of release hygiene. Each year's run gets its own
   `docs/security/threat-model-review-YYYY-MM.md` file.

---

## Deliverables

| Deliverable | Location | Status |
|---|---|---|
| Procedure / decision rationale (this file) | `docs/security/audit.md` | Authored. |
| 2026-05 STRIDE walkthrough | [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) | Drafted by maintainer. AI Round 1 verification pass on 2026-05-15 surfaced 1 High finding (T-2 / I-2 gitleaks integration gap, **resolved same-day in #58**) + 4 new informational findings. AI Round 2 multi-AI-agent review on 2026-05-15 (security / SRE / app-dev personas, see "Procedure amendment" below) returned `pass with findings` × 3 — 13 new informational findings. **Signed off** under amended step 3 (ii). |
| SECURITY.md updates | [`../../SECURITY.md`](../../SECURITY.md) | Updated 2026-05-15: the secret-leakage row describes the wired two-stage in-process scan (post-#58); the Pre-release security review section discloses the multi-AI-agent substitute. |
| Public summary | bottom of `threat-model-review-2026-05.md` "Summary of findings" section | Updated 2026-05-15. |

Closing issue #44 and tagging v1.0 (status as of 2026-05-15):

1. ~~The High finding (gitleaks integration gap, #58)~~ — resolved
   on 2026-05-15. `runReview` now wires `quickScanContent` at both
   the diff pre-scan and output post-scan surfaces.
2. ~~Unaffiliated reviewer sign-off~~ — met by the Round 2
   multi-AI-agent review on 2026-05-15 under amended step 3 (ii)
   below. Adopters needing higher assurance must commission their
   own engagement.

## Procedure amendment (2026-05-15)

The original step 3 of this procedure required "a reviewer
outside the project's primary author … cannot be self-attested".
For a personal-OSS project with no external contributors and no
hosted-tenancy operator funding an audit, this gate is
structurally unsatisfiable: every available reviewer is either
the maintainer or an AI tool that the maintainer invokes.

We therefore extended step 3 to accept a **multi-AI-agent
independent review** as an explicit substitute (form (ii) in the
procedure list). The amendment is intentionally narrow:

- Three AI agent personas (security researcher / SRE / app
  developer), not a single agent — to reduce single-perspective
  blind spots.
- Each agent is given the same walkthrough + source-code access
  and asked to challenge the assumptions, not confirm them.
- Each agent records a verdict (`pass` / `pass with findings` /
  `fail`) and the findings are integrated into the walkthrough.
- The AI nature is **fully disclosed** in the Sign-off table —
  adopters reading the walkthrough are not misled into thinking
  a paid third-party audit was performed.
- `SECURITY.md` "Pre-release security review" carries the
  caveat publicly.

This substitution is honest about its limits: AI agents
operated by the maintainer at the maintainer's machine do not
bring the external human accountability the original procedure
sought. But for a personal-OSS scope, the alternative is leaving
the gate open indefinitely — which adopters would also see and
arguably trust less than a transparent multi-agent walkthrough.
We chose transparency over indefinite open status. Adopters
requiring a paid human audit are explicitly directed to
commission their own.

The Round 2 review log lives at the bottom of
[`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md).
The annual re-review (step 6) repeats the same procedure;
single-AI-agent year-over-year drift is mitigated by re-running
the three persona agents each year.

When a willing human reviewer becomes available (a peer engineer,
security-focused collaborator, or hired consultant for a scoped
review), the maintainer should still solicit their feedback and
append a row to the Sign-off table — the amended procedure does
not preclude later human review, it only avoids leaving the gate
open indefinitely when no human is available.

---

## Cross-references

- [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) — the actual walkthrough.
- [`../../SECURITY.md`](../../SECURITY.md) — published threat model.
- [`./oncall.md`](./oncall.md) — incident response SLOs and tabletop
  format (referenced during the DoS / availability walkthrough).
- [`./byok.md`](./byok.md) — per-installation BYOK envelope encryption (Tampering / Information disclosure walkthrough input).
- [`./audit-log.md`](./audit-log.md) — HMAC chain (Repudiation walkthrough input).
- [`./red-team.md`](./red-team.md) — red-team eval fixtures (Information disclosure walkthrough input).
