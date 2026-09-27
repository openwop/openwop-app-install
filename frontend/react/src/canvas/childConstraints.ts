/**
 * Child-constraint adoption check (ADR 0344 slice 2c — CV-06). ONE rule shared
 * by every FE gate (palette add, preview drop, outline drop, paste): may this
 * parent adopt a child of this type right now? Mirrors the backend catalog
 * enforcement in `validateComponentTree` (allowedChildTypes + maxChildren are
 * HARD there; minChildren is a SOFT document warning — a container being
 * assembled legitimately has too few children mid-edit).
 */

export interface ChildConstraintDef {
  acceptsChildren?: boolean;
  allowedChildTypes?: readonly string[];
  maxChildren?: number;
}

/** `parentDef` null/undefined = the frame root (unconstrained). */
export function canAdopt(parentDef: ChildConstraintDef | null | undefined, childType: string, currentCount: number): boolean {
  if (!parentDef) return true;
  if (!parentDef.acceptsChildren) return false;
  if (parentDef.allowedChildTypes && !parentDef.allowedChildTypes.includes(childType)) return false;
  if (typeof parentDef.maxChildren === 'number' && currentCount >= parentDef.maxChildren) return false;
  return true;
}
