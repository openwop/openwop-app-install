import { OpenwopError } from '../types.js';

/**
 * ADR 0675 — reconcile the two shapes packs actually use when calling
 * `ctx.emit`, and refuse anything that is neither.
 *
 * The host signature is positional: `emit(type, payload)`. Packs in this repo
 * use BOTH that and a single-object form, in two spellings:
 *
 *   ctx.emit('artifact.created', { … })                       // positional
 *   ctx.emit({ type: 'node.progress', data: { … } })          // core.openwop.http
 *   ctx.emit({ kind: 'node.progress', payload: { … } })       // a2a, agents
 *
 * Before this existed the object forms wrote the WHOLE OBJECT into the
 * `events.type` column. MEASURED in production: 376 rows carrying a serialised
 * envelope where a type belongs.
 *
 * Why normalise rather than just reject: the object callers are not wrong in
 * spirit — they name a type and carry a payload — and rejecting them outright
 * would drop progress events that packs already ship. Why refuse the rest:
 * a type that is not a string is not a type, and writing it anyway is how a
 * log stops being readable. The refusal is a TYPED error so it surfaces as a
 * node failure rather than a silent gap.
 */
export function normaliseEmitArgs(
  type: unknown,
  payload: unknown,
): { type: string; payload: unknown } {
  if (typeof type === 'string') {
    if (type.length === 0) {
      throw new OpenwopError('validation_error', 'ctx.emit: the event type must be a non-empty string.', 400);
    }
    return { type, payload };
  }
  if (type !== null && typeof type === 'object') {
    const o = type as Record<string, unknown>;
    const named = typeof o.type === 'string' ? o.type : typeof o.kind === 'string' ? o.kind : undefined;
    if (named !== undefined && named.length > 0) {
      // The object form carries its own payload; a second positional argument
      // alongside it is a caller confusion, so the object's own wins and the
      // stray is dropped rather than silently merged.
      const body = 'payload' in o ? o.payload : 'data' in o ? o.data : undefined;
      return { type: named, payload: body ?? payload };
    }
  }
  throw new OpenwopError(
    'validation_error',
    'ctx.emit: the event type must be a non-empty string, or an object carrying `type`/`kind`. '
    + 'Writing a non-string here corrupts the `events.type` column (ADR 0675).',
    400,
    { received: typeof type },
  );
}
