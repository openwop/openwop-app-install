/**
 * Pack-declared canvas types (ADR 0310 Phase D — Tier-1 FE-less canvas packs).
 * An artifact-type pack may attach an `x-openwop-app.canvas` vendor extension
 * to a declared type (the `x-openwop-sensitive` precedent, RFC 0124): a
 * component CATALOG (feeds the agent prompt schema + closed-world validation
 * via `canvasComponentCatalog`) and/or EDITOR HINTS — pure data from which the
 * frontend synthesizes a `CanvasTypeDefinition` at runtime and the backend
 * registers generic editor routes. Phase D supports the ELEMENTS trait only
 * (positional, pure schema mirror — validation is the pack's own artifact
 * JSON Schema); tree/frames pack editing is the recorded follow-up.
 *
 * In-process registry, populated at pack-load time (boot), read by the
 * `canvas-packs` feature when it registers routes.
 */

/** One property field, as data (mirrors the FE `CanvasPropDef`). */
export interface PackPropDef {
  name: string;
  type: string; // string | number | boolean | enum | longtext | stringlist
  label?: string;
  options?: string[];
  required?: boolean;
}

export interface PackElementsCollection {
  /** The doc key holding the element array. */
  key: string;
  label: string;
  max: number;
  min?: number;
  /** The element field shown as the list-row label (fallback: the adder label). */
  itemLabelField?: string;
  adders: { id: string; label: string; defaults: Record<string, unknown> }[];
  /** The collection's fixed field set (per-kind fields = recorded follow-up). */
  fields: PackPropDef[];
}

export interface PackCanvasEditorHints {
  /** The doc key holding the display name the toolbar edits (default 'name'). */
  docNameKey?: string;
  docPropDefs?: PackPropDef[];
  collections: PackElementsCollection[];
}

export interface PackCanvasType {
  canvasTypeId: string;
  packName: string;
  /** Component catalog, STASHED here at pack-load — applied to the shared
   *  canvasComponentCatalog only by the `canvas-packs` feature AFTER every
   *  host feature has registered its types (the host-wins ownership check is
   *  only decidable then; applying at load time let a pack claiming a
   *  first-party id poison the closed-world catalog — code-review HIGH). */
  catalog?: import('./canvasComponentCatalog.js').ComponentDef[];
  editor?: PackCanvasEditorHints;
}

const registry = new Map<string, PackCanvasType>();

export function registerPackCanvasType(t: PackCanvasType): { replaced: boolean } {
  const replaced = registry.has(t.canvasTypeId);
  registry.set(t.canvasTypeId, t);
  return { replaced };
}

export function listPackCanvasTypes(): PackCanvasType[] {
  return [...registry.values()];
}

export function getPackCanvasType(canvasTypeId: string): PackCanvasType | undefined {
  return registry.get(canvasTypeId);
}

/** Test-only. */
export function __resetPackCanvasTypes(): void {
  registry.clear();
}
