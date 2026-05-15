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
| 2026-05 STRIDE walkthrough | [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) | **Signed off 2026-05-15** under amended step 3 (ii). Round 1 + Round 2 reviews complete; all findings recorded in that file. |
| SECURITY.md updates | [`../../SECURITY.md`](../../SECURITY.md) | Updated 2026-05-15 (in sync with the walkthrough). |
| Public summary | "Summary of findings" section at the bottom of [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) | Updated 2026-05-15. |

Closing issue #44 and tagging v1.0 (status as of 2026-05-15):

1. ~~The High finding (gitleaks integration gap, #58)~~ — resolved
   on 2026-05-15. `runReview` now wires `quickScanContent` at both
   the diff pre-scan and output post-scan surfaces.
2. ~~Unaffiliated reviewer sign-off~~ — met by the Round 2
   multi-AI-agent review on 2026-05-15 under amended step 3 (ii)
   below. Adopters needing higher assurance must commission their
   own engagement.

## Procedure amendment (2026-05-15) — rationale for form (ii)

Step 3 above lists two acceptable reviewer forms. Form (i) — an
unaffiliated human reviewer — remains the preferred option. Form
(ii) — a multi-AI-agent independent review — was added on
2026-05-15 because, for the **personal-OSS scope of this project**
(no external contributors, no hosted-tenancy operator paying for
assurance), form (i) is structurally unsatisfiable and the only
honest alternatives are (ii) or leaving the gate open
indefinitely. We chose transparency over indefinite open status.

Form (ii) is intentionally narrow:

- **Three** agent personas (not a single agent) to reduce
  single-perspective blind spots: security researcher / SRE /
  application developer.
- Each agent reads the same walkthrough + source and is asked to
  challenge the assumptions, not confirm them.
- Each records a verdict (`pass` / `pass with findings` / `fail`)
  and the findings are integrated into the walkthrough.
- The AI nature is fully disclosed in the Sign-off table — see
  the walkthrough's "Honest framing" note for the depth-of-review
  caveat that adopters should carry.

The Round 2 review log lives in the Sign-off table at the bottom
of [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md).
Step 6's annual re-review repeats form (ii); single-AI-agent
year-over-year drift is mitigated by re-running the three persona
agents each year. When a willing human reviewer becomes available,
the maintainer should still solicit form (i) review and append a
row to the Sign-off table — (ii) does not preclude later (i).

---

## Cross-references

- [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) — the actual walkthrough.
- [`../../SECURITY.md`](../../SECURITY.md) — published threat model.
- [`./oncall.md`](./oncall.md) — incident response SLOs and tabletop
  format (referenced during the DoS / availability walkthrough).
- [`./byok.md`](./byok.md) — per-installation BYOK envelope encryption (Tampering / Information disclosure walkthrough input).
- [`./audit-log.md`](./audit-log.md) — HMAC chain (Repudiation walkthrough input).
- [`./red-team.md`](./red-team.md) — red-team eval fixtures (Information disclosure walkthrough input).
