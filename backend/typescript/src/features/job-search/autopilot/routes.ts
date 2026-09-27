/**
 * ADR 0545 P2 — the answer-bank routes.
 *
 * A SEPARATE module from `job-search/routes.ts`, and the separation is
 * structural rather than tidiness. Every route in that file hangs off
 * `/orgs/:orgId/…` behind `authorizeOrgScope`; row 8 forbids that here, because
 * an org-admin must never read an employee's salary expectation. Keeping these
 * handlers in a file that never imports the org gate means the two postures
 * cannot be confused by a later edit — and it is what the ADR 0508 tenant-source
 * ratchet is checking for. That ratchet caught the first version of this code
 * living in the org-gated file, which was the right catch: `resolveCallerUser`
 * returns the caller's HOME tenant, and mixing that into a module whose other
 * handlers take the ACTIVE tenant from the gate is the exact defect ADR 0508
 * exists about.
 *
 * The home tenant IS the intended source here (the `profile-memory` precedent):
 * a person's salary expectation should not change because they switched
 * workspace. It follows the person, not the workspace.
 */
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../../featureRoute.js';
import { resolveCallerUser } from '../../users/usersGuards.js';
import { JOB_SEARCH_TOGGLE, JOB_SEARCH_LABEL } from '../service.js';
import { recordAnswer, listAnswers } from './answerBank.js';
import { listParked, clearParked } from './campaign.js';
import { STANDARD_BANK, CORE_KEYS, coverageReport } from './standardBank.js';
import { sendError } from '../../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: JOB_SEARCH_TOGGLE, label: JOB_SEARCH_LABEL };
const JOB_SEARCH_BASE = '/v1/host/openwop-app/job-search';

export function registerAnswerBankRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = `${JOB_SEARCH_BASE}/me/answers`;

  /** The standard bank + what THIS subject has answered + their coverage. */
  app.get(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      const mine = await listAnswers(user.tenantId, user.userId);
      const answered = mine.map((a) => a.questionKey);
      res.json({
        questions: STANDARD_BANK,
        coreKeys: CORE_KEYS,
        answers: mine.map((a) => ({
          questionKey: a.questionKey, questionText: a.questionText, value: a.value,
          source: a.source, confirmedAt: a.confirmedAt ?? null, usageCount: a.usageCount,
        })),
        // The toil metric, computed for THIS user's actual progress rather than
        // for the full bank — a number that only ever showed 95% would be
        // describing a hypothetical person.
        coverage: coverageReport(answered),
      });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      const b = (req.body ?? {}) as { questionText?: unknown; value?: unknown; source?: unknown; confirmed?: unknown };
      if (typeof b.questionText !== 'string' || typeof b.value !== 'string') {
        res.status(400).json({ error: 'validation_error', message: 'questionText and value are required.' });
        return;
      }
      const source = b.source === 'inferred' || b.source === 'profile' ? b.source : 'user';
      const out = await recordAnswer({
        tenantId: user.tenantId,
        // NEVER from the body. This single line is the authorization.
        subjectId: user.userId,
        questionText: b.questionText,
        value: b.value,
        source,
        confirmed: b.confirmed !== false,
        now: Date.now(),
      });
      if ('refused' in out) {
        // A special-category refusal is a 422 with its reason, not a silent
        // success: the wizard must be able to explain why nothing was stored.
        // H27-b — `reason` was a NEW TOP-LEVEL key; the schema is
        // `additionalProperties: false`, so it moves under `details`. The wizard
        // still gets the machine-readable refusal, at `details.reason`.
        sendError(
          res,
          422,
          'unprocessable',
          out.refused === 'special-category'
            ? 'This system does not store voluntary self-identification answers. Applications answer “decline to self-identify”.'
            : 'A question and an answer are both required.',
          { reason: out.refused },
        );
        return;
      }
      res.status(200).json({ answer: { questionKey: out.questionKey, value: out.value, source: out.source } });
    } catch (err) { next(err); }
  });

  /**
   * ADR 0545 D3 — the batched exceptions card.
   *
   * The whole interruption budget of a campaign, in one place, on the user's
   * schedule. Each row is ONE question with the applications waiting on it —
   * never one row per application, which is how "3 questions, ~40 seconds"
   * turns back into eighteen interruptions.
   */
  app.get(`${JOB_SEARCH_BASE}/me/exceptions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      const parked = await listParked(user.tenantId, user.userId);
      res.json({
        exceptions: parked.map((p) => ({
          questionKey: p.questionKey,
          questionText: p.questionText,
          reason: p.reason,
          blockedCount: p.blockedListings.length,
          firstSeenAt: p.firstSeenAt,
        })),
      });
    } catch (err) { next(err); }
  });

  /** Answer one parked question. Writes to the bank, then clears the backlog row. */
  app.post(`${JOB_SEARCH_BASE}/me/exceptions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      const b = (req.body ?? {}) as { questionText?: unknown; value?: unknown };
      if (typeof b.questionText !== 'string' || typeof b.value !== 'string') {
        res.status(400).json({ error: 'validation_error', message: 'questionText and value are required.' });
        return;
      }
      // ALWAYS confirmed: this endpoint exists because a human is answering.
      const out = await recordAnswer({
        tenantId: user.tenantId, subjectId: user.userId,
        questionText: b.questionText, value: b.value, source: 'user', confirmed: true, now: Date.now(),
      });
      if ('refused' in out) {
        sendError(res, 422, 'unprocessable', 'That answer cannot be stored.', { reason: out.refused });
        return;
      }
      // Cleared only AFTER the answer is durable. The other order would drop the
      // chore on a failed write and the user would never be asked again.
      await clearParked(user.tenantId, user.userId, out.questionKey);
      res.status(200).json({ questionKey: out.questionKey });
    } catch (err) { next(err); }
  });
}

