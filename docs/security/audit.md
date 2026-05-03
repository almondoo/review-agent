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
3. **Unaffiliated reviewer sign-off**: at least one reviewer who
   is not the project's primary author reads the walkthrough,
   challenges the assumptions, and either signs off or flags
   missing surfaces. **This step is the required gate for v1.0
   tagging — it cannot be self-attested.** The reviewer's
   affiliation, name (or initials, with the maintainer's
   verification on file), and the date of sign-off are recorded
   at the bottom of `threat-model-review-2026-05.md`.
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
| 2026-05 STRIDE walkthrough | [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) | Drafted by maintainer. **Awaiting unaffiliated reviewer sign-off.** |
| SECURITY.md updates | [`../../SECURITY.md`](../../SECURITY.md) | No new surfaces discovered in this round; existing mitigation table stays. |
| Public summary | bottom of `threat-model-review-2026-05.md` "Summary of findings" section | Drafted; updated if reviewer flags additional findings. |

The unaffiliated-reviewer gate is the **only blocker** for closing
issue #44 and tagging v1.0. The maintainer's responsibility is to
identify a willing reviewer (a peer engineer, security-focused
collaborator, or hired consultant for scoped review) and incorporate
their feedback before the v1.0 tag.

If no unaffiliated reviewer is available within a reasonable
timeframe, the v1.0 tag is gated indefinitely — we do not relax the
rule to ship faster. Issue #44 stays open.

---

## Cross-references

- [`./threat-model-review-2026-05.md`](./threat-model-review-2026-05.md) — the actual walkthrough.
- [`../../SECURITY.md`](../../SECURITY.md) — published threat model.
- [`./oncall.md`](./oncall.md) — incident response SLOs and tabletop
  format (referenced during the DoS / availability walkthrough).
- [`./byok.md`](./byok.md) — per-installation BYOK envelope encryption (Tampering / Information disclosure walkthrough input).
- [`./audit-log.md`](./audit-log.md) — HMAC chain (Repudiation walkthrough input).
- [`./red-team.md`](./red-team.md) — red-team eval fixtures (Information disclosure walkthrough input).
