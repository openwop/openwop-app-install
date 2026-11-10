/**
 * ADR 0777 + ADR 1040 D4 — conversation focus: the entity an embedded chat sits
 * beside, as a tool DEFAULT, for any entity kind a feature registers.
 *
 * A focus is never a grant. It is stored only after the kind's `authorize`
 * accepted the binding caller, and EVERY tool read re-runs `authorize` with the
 * calling turn's scope (`resolveAuthorizedFocus`), so a caller who lost access
 * since the bind reads nothing. A model-supplied explicit id goes through the
 * same check: before ADR 1040 the helper returned an explicit id unchecked and
 * relied on each tool re-checking downstream (true of CAD, the only caller, but
 * a trap for the next one).
 */
import type { BundleScope } from './inMemorySurfaces.js';
import { getConversationMeta } from './conversationStore.js';
import { getCanvasForCaller } from './canvasSurface.js';
import { featureAccessRefusal } from './workflowFeatureGate.js';

/** Who is asking: the same fields, spelled the same way, at bind and per call. */
export interface FocusAuthScope {
  tenantId: string;
  /** The acting user (`req.userId ?? req.principal.principalId` at bind;
   *  `BundleScope.actingUserId` on a tool call — the run's actor stamp). */
  actingUserId: string;
  personalTenant?: string | undefined;
}

export interface ConversationFocusKind {
  /** `<featureId>.<entity>` (e.g. `bookai.book`); the host's own is `canvas`. */
  kind: string;
  /** The owning feature: its toggle and plan are checked at bind AND per call.
   *  Required for every kind but the host's own; the kind must start with it. */
  featureId?: string;
  /** A noun for errors ("book"). Never an id, never model text. */
  label: string;
  /** May this caller READ the entity? Fail closed: a throw counts as no. */
  authorize: (scope: FocusAuthScope, id: string) => Promise<boolean>;
}

const KINDS = new Map<string, ConversationFocusKind>();
const KIND_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const HOST_KINDS = new Set(['canvas']);

/** Register a focus kind, at MODULE LOAD of the owning feature (not inside a
 *  per-app `register…` call: tests boot `createApp` many times per process).
 *  Throws on a malformed or duplicate kind, or a feature kind without its
 *  `featureId` (boot-time programming errors, never runtime conditions). */
export function registerConversationFocusKind(def: ConversationFocusKind): void {
  if (!HOST_KINDS.has(def.kind)) {
    if (!KIND_PATTERN.test(def.kind)) {
      throw new Error(`conversation focus kind "${def.kind}" must be "<featureId>.<entity>" (lowercase, dot-separated).`);
    }
    // A feature's kind is gated by that feature's toggle, so it must name it, and
    // its prefix must BE it: a kind cannot skip the gate by leaving it out.
    if (!def.featureId || !def.kind.startsWith(`${def.featureId}.`)) {
      throw new Error(`conversation focus kind "${def.kind}" must declare featureId, and start with "<featureId>.".`);
    }
  }
  if (KINDS.has(def.kind)) throw new Error(`conversation focus kind "${def.kind}" is already registered.`);
  KINDS.set(def.kind, def);
}

export function getConversationFocusKind(kind: string): ConversationFocusKind | undefined {
  return KINDS.get(kind);
}

/** Test seam — drop a registration a test added. */
export function __unregisterConversationFocusKind(kind: string): void {
  if (!HOST_KINDS.has(kind)) KINDS.delete(kind);
}

/** THE check, used at bind (the route) and on every tool read. */
export async function focusAuthorized(kind: string, scope: FocusAuthScope, id: string): Promise<boolean> {
  const def = KINDS.get(kind);
  if (!def || !scope.actingUserId || !id) return false;
  try {
    if (def.featureId) {
      const refusal = await featureAccessRefusal(def.featureId, scope.tenantId, { userId: scope.actingUserId });
      if (refusal !== null) return false;
    }
    return (await def.authorize(scope, id)) === true;
  } catch {
    return false;
  }
}

/**
 * The id a tool should act on for `kind`, or `undefined`: an explicit id from
 * the model wins, otherwise the conversation's stored focus of that kind — and
 * EITHER way only if the calling turn's acting user may read it right now.
 * The calling tool still applies its own predicate (defence in depth).
 */
export async function resolveAuthorizedFocus(
  scope: Pick<BundleScope, 'tenantId' | 'conversationId' | 'actingUserId' | 'personalTenant'>,
  kind: string,
  explicit?: string,
): Promise<string | undefined> {
  if (!scope.actingUserId) return undefined;
  let id = explicit;
  if (!id) {
    if (!scope.conversationId) return undefined;
    const focus = (await getConversationMeta(scope.tenantId, scope.conversationId))?.focus;
    id = focus?.kind === kind ? focus.id : undefined;
  }
  if (!id) return undefined;
  const auth: FocusAuthScope = { tenantId: scope.tenantId, actingUserId: scope.actingUserId, ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) };
  return (await focusAuthorized(kind, auth, id)) ? id : undefined;
}

// The host's own kind: a canvas, read through THE canvas predicate (ADR 0768 P0).
registerConversationFocusKind({
  kind: 'canvas',
  label: 'canvas',
  authorize: async (scope, id) => (await getCanvasForCaller(scope.tenantId, id, { subject: scope.actingUserId })) !== null,
});
