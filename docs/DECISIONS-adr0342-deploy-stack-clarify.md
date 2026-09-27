# Decision memos — ADR 0342 DECIDE-1/2/3 (deploy target · backend stack · clarify-interrupt)

**Date:** 2026-07-18 · **Prepared for:** the `docs/steward/TODO.md` §3 open decisions gating the
ADR 0342 finale (NEXT-1: P7 governed deployment, P8 completion). · **Method:**
`/architect` options-evaluation — repo constraint audit (ADRs 0342/0345/0346/0348/
0349/0295/0146 + code) × adversarial web evidence (vendor docs, pricing pages,
AI-builder precedents; links inline). Each memo ends with the falsifiability
condition that would flip it. **These are recommendations — the maintainer
ratifies.**

---

## DECIDE-3 — clarify-interrupt: **NO RFC NEEDED (the decision dissolves)**

**Finding:** the "input-collecting interrupt needs an OpenWOP RFC" premise
(ADR 0346:76 — "approvalGate can't carry text back") is TRUE about approvalGate
but FALSE about the platform:

- The `clarification` interrupt kind ships in the engine (`bootstrap/nodes.ts:929`
  `VALID_KINDS`), with `core.clarificationGate` emitting `data.question` +
  `data.schema` (`nodes.ts:912-926`).
- The resume path carries the caller's ANSWERS back (`routes/interrupts.ts:232-250`
  generic `resumeValue` → `executor.ts` `suspendResolution`/`reinvokeResolutions`).
- The accepted wire already specifies exactly this shape: `../openwop/spec/v1/
  interrupt.md` (Stable v1.1, kind union completed by RFC 0094) —
  `ClarificationData.questions[].schema` + `ClarificationResume = { answers[] }`.

**Recommendation:** compose the EXISTING `clarification` interrupt in the
app-builder Phase-4 loop (swap the approvalGate composition for
`core.clarificationGate` / `core.interrupt` + `resumeValue`), and add a dated
correction note to ADR 0346's deferral text. An RFC becomes necessary ONLY if a
new cross-host normative artifact (a collection-review envelope / run-event
field) is proposed — which nothing currently requires.
**Falsifiability:** if implementation shows the Phase-4 loop needs multi-round
question/answer state that `ClarificationResume` cannot express, revisit — as a
spec conversation first.

---

## DECIDE-1 — deploy-adapter target: **Cloud Run, same GCP project** (Cloudflare Workers for Platforms as the recorded scale-out alternative)

| Force | Cloud Run (same project) | Cloudflare WfP | Netlify/Vercel |
|---|---|---|---|
| Governance/audit (the ADR's dominant force) | **IAM + Cloud Audit Logs + org policies + per-service SAs — native, no new vendor/token custody** | outbound-Worker egress interception (unique) but account-scoped tokens; audit = enterprise tier | enterprise-gated governance |
| Deploy/rollback contract (ADR 0349) | Admin API v2; **revisions ARE the rollback primitive** | versioned uploads, rollback-by-reupload | mature APIs |
| Isolation | gVisor per service + resource caps | V8 isolate (lighter) | shared function infra |
| Custom domains | native mapping still preview (15-cert ceiling) → **GCLB + Certificate Manager — the SAME operator TLS tier ADR 0295 already runs** for custom-domain content | best-in-class (Cloudflare for SaaS, per-hostname fee) | automated, mature |
| Cost at many-small-apps | scale-to-zero ≈ free idle; watch per-project service quotas (~1k/region, raisable) | cheapest at scale ($25 base + usage; static free) | Netlify re-priced 2026-04 (credits doubled on bandwidth/compute) |
| Precedent | **Replit runs all generated apps on GCP/Cloud Run** | purpose-built platform-of-platforms product | Bolt shipped 1M apps via Netlify |

**Recommendation:** Cloud Run in the existing `openwop-dev`-style project. It is
the only option where the ADR's governance frame (auditable, no credential
leaves host custody, no new vendor) is native rather than negotiated, the
platform team already operates the substrate, and the one real gap — per-app
custom hostnames — extends the **ADR 0295 GCLB certificate-map tier the
operator already runs** instead of standing up new vendor machinery. The
`deploy-adapter` pack stays host-internal (no RFC; ADR 0349:43-45 gate noted).
**Falsifiability:** if generated-app count approaches per-project service quotas
at a rate raises can't match, or per-app LB/hostname automation cost exceeds
Cloudflare's per-hostname fee at volume, pivot the adapter to Workers for
Platforms — the adapter seam (ADR 0349's contract) is provider-shaped precisely
so this is a second adapter, not a rewrite.

---

## DECIDE-2 — backend-generation stack: **TypeScript (Hono/Express-class) + Drizzle ORM + Postgres, containerized**

**The repo's hard constraints** (ADR 0348 §6e): the generator must emit
**migrations + SBOM + conformance fixtures**, deterministically, from the same
canonical `models[]`/`operations[]` that already produce `openapi.json`
(same-canvas ⇒ same-hash gate, ADR 0342:83). All seven existing export targets
are frontend; the backend generator is greenfield.

**Why this stack:**
- **Deterministic artifacts** — `drizzle-kit generate` emits inert SQL migration
  files from a TypeScript schema (hashable, diffable, fixture-seedable); one
  lockfile ⇒ clean SBOM (syft/CycloneDX); fixtures are ordinary seed scripts.
  This is precisely the artifact shape 6e demands.
- **One language** — the generator already emits TypeScript; models[]→Drizzle
  schema is a direct closed-world mapping (the same projection that builds the
  OpenAPI doc).
- **Deploys onto the DECIDE-1 lane** — a plain Node container is Cloud Run's
  native unit; no second backend vendor.
- **Market alignment** — the 2026 generator convergence is "Postgres + checked-in
  SQL migrations" (Supabase-style); Drizzle delivers the same artifact story
  without adopting Supabase's hosted platform as a per-app dependency.

**Alternative recorded — Supabase**: wins when generated apps need
auth/RLS/realtime out of the box (the v0/Lovable/Bolt default), at the cost of a
second vendor + per-app project provisioning inside the governed-deploy story.
**Falsifiability:** if the first real generated-app cohort's dominant missing
piece is end-user auth (not CRUD), flip to Supabase-style emit — the generator
seam (models[]→schema) is shared; the delta is the runtime adapter + auth
scaffold.

---

*Ratify by updating `docs/steward/TODO.md` §3 (DECIDE-1/2/3) and, on DECIDE-1/2 ratification,
opening the 6e/P7 implementation slice per ADR 0348/0349's recorded activation
triggers. DECIDE-3's correction note lands in ADR 0346 with this memo.*
