/**
 * ADR 0808 — conditional field visibility, `form-content-packs.md`
 * §"Conditional visibility" (RFC 0177 §E.4).
 *
 * A field MAY carry `when`, and its grammar IS the workflow edge condition
 * `{ type, left, right }`. "No second expression language": a form that hides
 * a field and an edge that skips a node answer the same question, so this
 * module answers it with the SAME two functions the chain loader and the
 * executor use — `mapEdgeCondition` (shape + supported operators) and
 * `evaluateCondition` (the verdict). It adds only what is form-specific:
 *
 * - **What `left` names.** `fields.<key>` of an EARLIER field. Earlier, so
 *   visibility resolves in one pass in authored order and a cycle cannot be
 *   written; another field, because a condition on nothing is dead.
 * - **What hidden means at submit.** A hidden field is not required and its
 *   value is DROPPED, so a value the visitor could not see never persists. A
 *   field hidden because its controller is hidden is hidden too: the
 *   controller's value is dropped before the dependent is judged.
 *
 * `expression` and `regex` are refused at authoring time with the same code
 * the chain loader uses (`chain_edge_condition_unsupported`) — one host, one
 * set of supported operators, never a field that silently always shows.
 *
 * A HOST module, not a forms one, because the form-content pack loader must
 * refuse at load what `createForm` would refuse at instantiation, and the
 * loader may not import a feature.
 */
import { OpenwopError } from '../types.js';
import { mapEdgeCondition, type WireEdgeCondition } from './edgeConditionMapping.js';
import { evaluateCondition } from '../executor/scheduler.js';

export type FieldWhen = Pick<WireEdgeCondition, 'type' | 'left' | 'right'>;

const LEFT = /^fields\.([a-zA-Z0-9_]{1,64})$/;

/** Validate an authored `when`; `earlierKeys` are the keys of the fields before
 *  this one. Returns the stored wire shape (`right` dropped where meaningless). */
export function sanitizeWhen(raw: unknown, index: number, key: string, earlierKeys: ReadonlySet<string>): FieldWhen {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', `fields[${index}].when MUST be an edge condition object { type, left, right }.`, 400, { field: key });
  }
  const c = raw as WireEdgeCondition & Record<string, unknown>;
  // The grammar and the supported-operator set are the chain loader's own.
  const host = mapEdgeCondition(c, `fields[${index}].when`);
  const m = LEFT.exec(host.path);
  if (!m) {
    throw new OpenwopError('validation_error', `fields[${index}].when.left MUST be "fields.<key>" of an earlier field.`, 400, { field: key });
  }
  if (!earlierKeys.has(m[1]!)) {
    throw new OpenwopError('validation_error', `fields[${index}].when.left names "${m[1]}", which is not an earlier field of this form.`, 400, { field: key });
  }
  return { type: c.type, left: host.path, ...('value' in host ? { right: host.value } : {}) };
}

/**
 * The keys a visitor can see given `values`, in authored order. Judged
 * against the values of VISIBLE earlier fields only, so a hidden controller
 * hides its dependents.
 */
export function visibleFieldKeys(fields: ReadonlyArray<{ key: string; when?: FieldWhen }>, values: Record<string, unknown>): Set<string> {
  const visible = new Set<string>();
  const seen: Record<string, unknown> = {};
  for (const f of fields) {
    const shown = f.when === undefined
      || evaluateCondition(mapEdgeCondition(f.when, `field ${f.key}`), { fields: seen });
    if (shown) {
      visible.add(f.key);
      if (values[f.key] !== undefined) seen[f.key] = values[f.key];
    }
  }
  return visible;
}
