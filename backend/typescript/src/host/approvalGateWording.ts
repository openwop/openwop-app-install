/**
 * ADR 1040 D7 F1 (Book AI P47) — a feature's own WORDING on the inline approval
 * card, mapped onto the gate's EXISTING verbs.
 *
 * Config keys on `core.approvalGate`, and on `core.interrupt`'s forwarded data
 * (copied into the interrupt RECORD's data). The closed ApprovalData
 * projection of `interrupt.requested` does not carry them. Its `custom`
 * fallback (no protocol verb, or no preview) carries the host data opaquely,
 * exactly as it already carries `prompt` and `options`; they are i18n keys and
 * a boolean, never text (`executor/interruptRequestedPayload.ts`):
 *  - `actionLabels: { <verb>: "<ns>:<key>" }` — an i18n key per verb the gate
 *    already lists in `actions`. A label is display only: the decided verb, the
 *    server's action enforcement and ADR 0600 semantics do not change.
 *  - `promptKey: "<ns>:<key>"` — the card's prompt as an i18n key (the plain
 *    `prompt` stays the fallback, and is still what the wire title uses).
 *  - `declineExpected: true` — rejecting is an EXPECTED answer here (an author
 *    declining a suggestion), so the card confirms it without the
 *    "fail the run" danger copy. The verb is still `reject`.
 *
 * Closed-world, refused at the writer like `rejectionPolicy` (ADR 0600 §6): a
 * malformed value is an `invalid_config` failure where a human can fix it,
 * never forwarded to be silently ignored by the card.
 */

/** A namespaced i18n key: `<namespace>:<key>`. Never free text, never markup. */
const I18N_KEY = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9_.-]{1,128}$/;

export interface ApprovalGateWording {
  actionLabels?: Record<string, string>;
  promptKey?: string;
  declineExpected?: boolean;
}

type Failure = { status: 'failure'; error: { code: string; message: string } };

const fail = (typeId: string, message: string): Failure => ({
  status: 'failure',
  error: { code: 'invalid_config', message: `${typeId}: ${message}` },
});

/** Read and validate the wording keys. Returns the data to merge, or a failure. */
export function readApprovalGateWording(
  typeId: string,
  cfg: { actionLabels?: unknown; promptKey?: unknown; declineExpected?: unknown },
  actions: readonly unknown[],
): ApprovalGateWording | Failure {
  const out: ApprovalGateWording = {};
  if (cfg.actionLabels !== undefined) {
    const v = cfg.actionLabels;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return fail(typeId, 'actionLabels must be an object mapping a listed action to an i18n key ("<namespace>:<key>").');
    }
    const labels: Record<string, string> = {};
    for (const [verb, key] of Object.entries(v as Record<string, unknown>)) {
      if (!actions.includes(verb)) {
        return fail(typeId, `actionLabels names "${verb}", which is not one of this gate's actions (${actions.map(String).join(', ')}). A label renames a verb; it cannot add one.`);
      }
      if (typeof key !== 'string' || !I18N_KEY.test(key)) {
        return fail(typeId, `actionLabels.${verb} must be an i18n key like "myfeature:approveLabel" (got ${JSON.stringify(key)}).`);
      }
      labels[verb] = key;
    }
    if (Object.keys(labels).length > 0) out.actionLabels = labels;
  }
  if (cfg.promptKey !== undefined) {
    if (typeof cfg.promptKey !== 'string' || !I18N_KEY.test(cfg.promptKey)) {
      return fail(typeId, `promptKey must be an i18n key like "myfeature:gatePrompt" (got ${JSON.stringify(cfg.promptKey)}).`);
    }
    out.promptKey = cfg.promptKey;
  }
  if (cfg.declineExpected !== undefined) {
    if (typeof cfg.declineExpected !== 'boolean') return fail(typeId, 'declineExpected must be a boolean.');
    if (cfg.declineExpected) out.declineExpected = true;
  }
  return out;
}

export function isWordingFailure(v: ApprovalGateWording | Failure): v is Failure {
  return (v as Failure).status === 'failure';
}
