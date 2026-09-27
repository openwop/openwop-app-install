/**
 * Submit guards (ADR 0338 §D4 — closes ADR 0017 alt-4). A guard is a
 * pre-persist check on the PUBLIC submit, registered by another feature or an
 * operator extension (CAPTCHA/turnstile providers are future registrants —
 * the seam ships with none). Guards run AFTER the honeypot and BEFORE
 * validation; any `deny` short-circuits with the honeypot's bot posture
 * (silent 200, no row) so the endpoint never becomes a spam oracle.
 * Fail-open on a thrown guard: an anti-spam outage must never drop leads.
 */

import { createLogger } from '../../observability/logger.js';
import type { FormDef, Submission } from './formsService.js';

const log = createLogger('forms.submitGuards');

export interface SubmitGuard {
  id: string;
  check(form: FormDef, values: Record<string, unknown>, meta: Submission['meta']): Promise<'allow' | 'deny'>;
}

const guards: SubmitGuard[] = [];

export function registerSubmitGuard(guard: SubmitGuard): void {
  const i = guards.findIndex((g) => g.id === guard.id);
  if (i >= 0) guards[i] = guard;
  else guards.push(guard);
}

export function clearSubmitGuardsForTest(): void {
  guards.length = 0;
}

/** True ⇒ the submit proceeds. A deny is logged with the guard id. */
export async function runSubmitGuards(form: FormDef, values: Record<string, unknown>, meta: Submission['meta']): Promise<boolean> {
  for (const guard of guards) {
    try {
      if ((await guard.check(form, values, meta)) === 'deny') {
        log.info('submission denied by guard', { guard: guard.id, formId: form.formId });
        return false;
      }
    } catch (err) {
      log.warn('submit guard failed — failing open', { guard: guard.id, formId: form.formId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return true;
}
