/**
 * `approval.overridden` on the major-2 read — one stored payload, legal on both
 * majors (openwop#1742 follow-on).
 *
 * v1 (`interrupt-profiles.md:95`, RFC 0051 §B / RFC 0093 §D.2): taking the
 * override path MUST emit `approval.overridden { principal, reason }`, and the
 * v1 def is CLOSED with `required: [gateId, principal, reason]`. So that is what
 * is STORED (`routes/interrupts.ts`), with `gateId` = the gate's interrupt id.
 *
 * v2: the kind-specific type is kept, but its payload def is a `$ref` alias of
 * the closed `interruptResolved` (RFC 0171 §A.4 E4), which forbids `gateId` and
 * `principal` and REQUIRES `nodeId` + `interruptId`. This projects the stored v1
 * shape onto it at egress, the way `projectV2OwnerEcho` rebuilds the owner block:
 *   gateId    → interruptId
 *   envelope  → nodeId
 *   principal → resolvedBy (the legacy Subject, `runOwner.legacySubject`)
 *   + kind `approval`, decision `overridden`, action `accept` (an override APPLIES
 *     accept — the ADR 0725 normalisation `interrupt.resolved` already records).
 * The override `reason` is a HUMAN's justification. `interruptResolved.reason` is
 * the cause of a resolution WITHOUT a human (RFC 0186 §A.2, max 64 chars), so the
 * justification is carried as `overrideReason`, which the closed+hatched def
 * boxes under `vendor.openwop-app` (RFC 0185 §C): carried, never dropped.
 *
 * Rows written before this change (`{interruptId, principal, reason,
 * bypassedQuorum}`) project the same way. Idempotent: a payload that already
 * carries `resolvedBy` or `decision` is returned unchanged.
 */
import { legacySubject } from '../host/runOwner.js';

export function projectApprovalOverridden(
  type: string,
  payload: unknown,
  envelope: { nodeId?: string },
  runTenant?: string,
): unknown {
  if (type !== 'approval.overridden') return payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if ('resolvedBy' in p || 'decision' in p) return payload;
  const { gateId, interruptId, principal, reason, ...rest } = p;
  const id = typeof gateId === 'string' ? gateId : interruptId;
  return {
    ...rest,
    ...(envelope.nodeId !== undefined ? { nodeId: envelope.nodeId } : {}),
    ...(typeof id === 'string' ? { interruptId: id } : {}),
    kind: 'approval',
    decision: 'overridden',
    action: 'accept',
    ...(typeof principal === 'string' && principal.length > 0 ? { resolvedBy: legacySubject(principal, runTenant ?? 'default') } : {}),
    ...(typeof reason === 'string' ? { overrideReason: reason } : {}),
  };
}
