/**
 * ADR 0837 D7 — how the contact Triage action turns a toggle assignment into
 * work. Before this, the route launched the demo `openwop-app.uppercase`
 * workflow and the variant's `crm.triage` binding was stamped and never read
 * (`CRM2WF-1`; ADR 0819 §6 deferred exactly this dispatcher).
 *
 * The binding selects a node; the chain `crm-ops.triage` holds the graph, and
 * the binding reaches it as the run INPUT `variant`. Replay and `:fork` re-seed
 * from `run.inputs` and read the stamp — nothing here is re-resolved after
 * dispatch.
 */

import { OpenwopError } from '../../types.js';
import type { VariantBinding } from '../../host/featureToggles/types.js';

/** The workflow the contact Triage action launches (same-id chain-backed). */
export const CRM_TRIAGE_WORKFLOW_ID = 'crm-ops.triage';

/** The `crm.triage` binding slot. */
export const CRM_TRIAGE_SLOT = 'crm.triage';

/**
 * The CLOSED candidate set for the slot — `VariantBinding`'s "the candidate set
 * is declared by the owning manifest". Keyed on the node NAME: a binding pins a
 * version, and the node moves under it (A9).
 */
export const CRM_TRIAGE_BINDING_VARIANTS: Readonly<Record<string, 'basic' | 'enriched'>> = {
  'feature.crm.nodes.triage': 'basic',
  'feature.crm.nodes.triage-enriched': 'enriched',
};

/**
 * The run input for an assignment's bindings. No binding for the slot (a tenant
 * override with no variants, or variants without bindings) ⇒ `basic`, marked
 * `default` so the stamp says which. A binding naming anything outside the
 * candidate set is refused (422) rather than silently scored as `basic`.
 */
export function triageVariantFor(bindings: readonly VariantBinding[] | undefined): { variant: 'basic' | 'enriched'; bindingSource: 'binding' | 'default' } {
  const b = bindings?.find((x) => x.slot === CRM_TRIAGE_SLOT);
  if (!b) return { variant: 'basic', bindingSource: 'default' };
  const variant = b.ref.kind === 'node' ? CRM_TRIAGE_BINDING_VARIANTS[b.ref.name] : undefined;
  if (!variant) {
    throw new OpenwopError('validation_error', `The CRM toggle binds triage to "${b.ref.name}", which this host cannot run. Rebind the variant to one of: ${Object.keys(CRM_TRIAGE_BINDING_VARIANTS).join(', ')}.`, 422, { reason: 'triage_binding_unsupported', slot: CRM_TRIAGE_SLOT, ref: b.ref.name });
  }
  return { variant, bindingSource: 'binding' };
}
