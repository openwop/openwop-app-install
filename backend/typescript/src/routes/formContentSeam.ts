/**
 * RFC 0137 conformance test seam — `host-sample-test-seams.md`.
 *
 *   POST /v1/host/sample/formcontent/instantiate   { templateId }
 *
 * The behavioral witness for `host.forms.contentPacks`. RFC 0137 shipped
 * `Active` with only server-free corpus legs, so nothing could observe a host;
 * `form-content-instantiation.test.ts` (openwop#885) is the leg that can, and
 * this is the surface it drives.
 *
 * Like the RFC 0095/0120 connection-pack seam, this routes through the SAME
 * production code the product path uses — the real `formContentPackLoader`
 * (validation, wire→host translation, vendor-extension degradation) and the real
 * `createForm` (the normal create path). It only supplies the conformance FIXTURE
 * TEMPLATES that production sources from installed packs. A seam that
 * reimplemented instantiation would witness itself, not the host.
 *
 * The response is a projection, not a second model: `viaCreatePath` is true only
 * because the handler literally called `createForm`, and `fields[]` is read back
 * off the persisted `FormDef` rather than echoed from the request.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import {
  loadFormContentPacks,
  getFormTemplateEntry,
  createFormContentRegistry,
  type FormContentRegistry,
} from '../host/formContentPackLoader.js';
import { createForm, FIELD_TYPES } from '../features/forms/formsService.js';
import { requireNonAnonymousPrincipal } from '../middleware/auth.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.formContentSeam');

/** Conformance-only tenant/org — never a real workspace. */
const SEAM_TENANT = 'user:conformance-formcontent';
const SEAM_ORG = 'org-conformance-formcontent';

/** The fixture templates the published suite drives (openwop#885). Loaded from
 *  the conformance fixture root, NOT from `packs/` — they must never ship to a
 *  real operator's catalog. */
const FIXTURE_ROOT_ENV = 'OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES';

let fixturesLoaded = false;

/** Seam-LOCAL registry (DOCT-12). Fixtures load here, never into the product's
 *  module-global registry — before this, any process with the fixture env var
 *  set served `vendor.conformance.form.*` in every tenant's `GET /form-templates`
 *  picker. Lookup below checks this view first, then falls back to the global
 *  registry so a host running the seam still serves its own installed packs —
 *  the seam ADDS fixtures for its own requests only, it never edits the catalog. */
const seamRegistry: FormContentRegistry = createFormContentRegistry();

/** Load the conformance fixture pack ONCE, through the real loader. */
function ensureFixtures(): void {
  if (fixturesLoaded) return;
  const root = process.env[FIXTURE_ROOT_ENV];
  if (!root) {
    log.info('form_content_seam_no_fixture_root', { env: FIXTURE_ROOT_ENV });
    fixturesLoaded = true;
    return;
  }
  const out = loadFormContentPacks({ roots: [root], registry: seamRegistry });
  if (out.errors.length) log.warn('form_content_seam_fixture_errors', { errors: out.errors.slice(0, 3) });
  fixturesLoaded = true;
}

export function registerFormContentSeamRoutes(app: Express): void {
  // DOCT-1 — this seam persists REAL rows through the REAL `createForm` (which
  // has no per-org cap), so an always-on, unauthenticated mount was an
  // unbounded anonymous durable write. Same posture as `testSeam.ts` /
  // `mcpInvokeSeam.ts`: env-gated mount + non-anonymous principal.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('form content seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  log.warn('form content seam ENABLED — /v1/host/sample/formcontent/instantiate is reachable. NEVER enable in production.');

  const guard = requireNonAnonymousPrincipal('the RFC 0137 form-content conformance seam');
  app.post('/v1/host/sample/formcontent/instantiate', guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureFixtures();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const templateId = typeof body.templateId === 'string' ? body.templateId : '';
      // Seam-local fixtures first, then the host's own installed packs.
      const entry = getFormTemplateEntry(templateId, seamRegistry) ?? getFormTemplateEntry(templateId);
      if (!entry) {
        // `refused` is the leg's vocabulary for "the host would not instantiate".
        // A template the loader REJECTED (e.g. a malformed field type) lands here,
        // which is correct: refusing malformed input is conformant; refusing a
        // well-formed vendor extension is not, and leg #2 asserts the difference.
        res.status(200).json({ refused: true, reason: 'template_not_registered', templateId });
        return;
      }

      // THE NORMAL CREATE PATH — the same call the product route makes. Nothing
      // about this form is privileged relative to a hand-authored one.
      const form = await createForm({
        tenantId: SEAM_TENANT,
        orgId: SEAM_ORG,
        title: entry.template.title,
        fields: entry.template.fields,
        createToContact: false,
        originTemplate: {
          templateId,
          packName: entry.packName,
          packVersion: entry.packVersion,
          ...(entry.templateVersion ? { templateVersion: entry.templateVersion } : {}),
        },
        createdBy: 'conformance',
      });

      // Read the projection off the PERSISTED form, not off the request — the
      // leg is asking what the host actually stored, and `declaredType` comes
      // from the template so #2 can compare wire-declared vs host-chosen.
      const declaredByKey = new Map(entry.template.fields.map((f) => [f.key, f.declaredType ?? f.type]));
      res.status(200).json({
        formId: form.formId,
        viaCreatePath: true,
        // §F2 — a pack cannot bind a destination. `createForm` was called with no
        // `intakeBinding`, and the loader refuses one in a template, so this is
        // absent by construction rather than stripped here.
        ...(form.intakeBinding ? { routing: form.intakeBinding } : {}),
        fields: form.fields.map((f) => ({
          id: f.key,
          control: f.type,
          declaredType: declaredByKey.get(f.key) ?? f.type,
          // Pack-authored fields carry no privilege — the instantiating user may
          // rename or remove any of them, exactly like a hand-added field.
          editable: true,
        })),
        // Surfaced so a failure names the catalog the host actually honours.
        hostControls: [...FIELD_TYPES],
      });
    } catch (err) {
      next(err);
    }
  });
}
