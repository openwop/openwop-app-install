/**
 * Schema-driven run-input forms (ADR 0197) — a ROUTE-LESS feature (the
 * developer-tools pattern, ADR 0196 Phase 1). The frontend launch form renders
 * a typed input form from a workflow's `inputSchema`; `routes/runs.ts` applies
 * the matching best-effort Ajv validation on run creation.
 *
 * § Correction (ADR 0434) — graduated off its toggle to always-on.
 * ADR 0197 shipped this behind the `run-input-forms` toggle explicitly as a
 * pre-GA opt-in: `host/runInputValidation.ts` and `routes/runs.ts` both said
 * "gated on the `run-input-forms` toggle so behavior is opt-in until the toggle
 * GAs". It has GA'd (Phases 1–3 parity was proven at the time: 10 renderer
 * tests + 6 route-level validation tests + the full FE/BE gates). The toggle
 * was never a product curtain — it gated a rendering + validation behavior on
 * the CORE runs surface, which is why the gate lived in core `routes/runs.ts`
 * rather than in this package (a feature toggle reaching into core is the
 * boundary smell ADR 0001 guards against). `distributions/bundles.json` already
 * classified it `core` substrate while the toggle still advertised it as
 * optional — the two catalogs disagreed, and the distribution catalog
 * (CI-enforced, dependsOn-closed) was right.
 *
 * The validation stays FAIL-OPEN by construction: a workflow with no
 * `inputSchema`, or a schema Ajv cannot compile, proceeds exactly as before.
 * Only a schema-bearing workflow with an actually-invalid payload gets a 400 —
 * and the raw-JSON editor remains the escape hatch on the launch surface.
 *
 * @see docs/adr/0434-graduate-substrate-toggles.md
 */

import type { BackendFeature } from '../types.js';

export const runInputFormsFeature: BackendFeature = {
  id: 'run-input-forms',
  registerRoutes: () => {},
  // No toggleDefault — graduated off its toggle (§ Correction above).
};
