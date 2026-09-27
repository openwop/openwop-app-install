/**
 * feature.users.nodes — host-account lifecycle nodes over `ctx.features.users`
 * (ADR 0617 D2). Pure-JS, Node-20 stdlib only.
 *
 * The bodies do ZERO auth. Every decision — acting user present + active,
 * `host:members:manage` in the run's tenant, target in-tenant, self-lockout —
 * lives in the host surface (`features/users/surface.ts`), which is the SAME
 * predicate the `/users` admin routes use. A system run (schedule, webhook, or a
 * host-event-started run — the dispatcher stamps no acting user) is refused
 * there with a named exit; the node forwards the typed error, it never softens
 * it into `status:'success'`.
 *
 * REPLAY / FORK: both nodes declare `"role": "side-effect"` + `side-effectful`
 * (the derived floor) AND carry an explicit `SIDE_EFFECTING_TYPE_PATTERNS`
 * entry in `executor/sideEffects.ts` (the #2871 two-leg lesson — a pack `.mjs`
 * cannot set `module.sideEffecting`). A `:fork` is served the source run's
 * recorded outcome and never re-runs the status write.
 *
 * WHERE `userId` COMES FROM, in precedence order (runtime facts win over
 * authoring-time defaults — the merged-args idiom `WF-CMNT-3`):
 *   1. `ctx.inputs.userId`            — an edge-delivered value;
 *   2. `ctx.triggerData.payload.userId` — the run-scoped, replay-persisted
 *      payload of the `host.users.user.*` event that started the run (what
 *      `core.trigger.event` forwards on its `payload` port). Read here rather
 *      than wired by edge because the offboarding chain keeps this node behind
 *      ONE gated inbound edge (`attest` → `{truthy approved}`), and a second,
 *      unconditional trigger edge would be a structural gate escape.
 *      HONOURED ONLY when `ctx.triggerData.eventName` is a `host.users.user.*`
 *      event (review SHOULD-2, 1.0.1): on a MANUAL run the executor sets
 *      `ctx.triggerData = run.inputs`, so without this check a run started
 *      with `inputs: { payload: { userId } }` silently retargeted the frozen
 *      chain parameter through an input no schema declares;
 *   3. `ctx.config.userId`            — the chain parameter (`{{params.userId}}`
 *      frozen at instantiation; RFC 0013 Path A freezes an unset optional param
 *      to `''`, which is why an empty string falls through to a typed error).
 */

function ensureUsers(ctx) {
  const users = ctx.features && ctx.features.users;
  if (!users || typeof users.deactivate !== 'function' || typeof users.reactivate !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.users — the Users feature must be composed (ADR 0617 D2)'),
      { code: 'host_capability_missing', capability: 'host.sample.users' },
    );
  }
  return users;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** The event-lane prefix: only a run started by a users lifecycle event may
 *  hand this node its target through `triggerData.payload`. */
const USERS_EVENT_PREFIX = 'host.users.user.';

function eventPayloadUserId(ctx) {
  const trigger = ctx.triggerData && typeof ctx.triggerData === 'object' ? ctx.triggerData : {};
  if (!str(trigger.eventName).startsWith(USERS_EVENT_PREFIX)) return '';
  const payload = trigger.payload && typeof trigger.payload === 'object' ? trigger.payload : {};
  return str(payload.userId);
}

function resolveUserId(ctx) {
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};
  const userId = str(inputs.userId) || eventPayloadUserId(ctx) || str(config.userId);
  if (!userId) {
    throw Object.assign(
      new Error('userId is required — supply it as an input, run the chain from a host.users.user.* event, or set the `userId` chain parameter'),
      { code: 'validation_error', field: 'userId' },
    );
  }
  return userId;
}

export async function deactivate(ctx) {
  const users = ensureUsers(ctx);
  const out = await users.deactivate({ userId: resolveUserId(ctx) });
  return { status: 'success', outputs: { userId: out.userId, status: out.status } };
}

export async function reactivate(ctx) {
  const users = ensureUsers(ctx);
  const out = await users.reactivate({ userId: resolveUserId(ctx) });
  return { status: 'success', outputs: { userId: out.userId, status: out.status } };
}

export const nodes = {
  'feature.users.nodes.deactivate': deactivate,
  'feature.users.nodes.reactivate': reactivate,
};

export default nodes;
