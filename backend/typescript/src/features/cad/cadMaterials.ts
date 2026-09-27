/**
 * CAD material library (ADR 0388 P5). FE↔BE TWIN (frontend/react/src/features/
 * cad/cadMaterials.ts is byte-identical, parity-pinned).
 *
 * The STARTER library is the closed world: assignment is by `materialId` from
 * this catalog — never free material JSON (the 0333 `url()`-beacon lesson:
 * paint values here are #hex only, structurally incapable of smuggling a URL).
 * A model may still carry inline color/metallic/roughness (the pre-P5 fields);
 * `materialId` RESOLVES to catalog values and takes precedence when present.
 *
 * Third-party material PACKS (`cad-material` pack kind) are the recorded
 * deferral — the catalog module is the seam they would extend.
 */

export interface CadMaterial {
  id: string;
  /** #hex only — the safe-paint grammar. */
  color: string;
  metallic: number;
  roughness: number;
  /** Emissive tint (#hex) — rendered as a brightness floor in the viewer. */
  emissive?: string;
}

export const CAD_MATERIALS: readonly CadMaterial[] = [
  { id: 'steel', color: '#8c96a0', metallic: 0.9, roughness: 0.35 },
  { id: 'aluminum', color: '#c0c6cc', metallic: 0.85, roughness: 0.3 },
  { id: 'brass', color: '#c9a24b', metallic: 0.9, roughness: 0.4 },
  { id: 'copper', color: '#b0704f', metallic: 0.9, roughness: 0.35 },
  { id: 'gold', color: '#d4af37', metallic: 1, roughness: 0.25 },
  { id: 'plastic-red', color: '#c0392b', metallic: 0.05, roughness: 0.6 },
  { id: 'plastic-blue', color: '#2e6da4', metallic: 0.05, roughness: 0.6 },
  { id: 'plastic-black', color: '#2b2b2e', metallic: 0.05, roughness: 0.55 },
  { id: 'plastic-white', color: '#e8e8e4', metallic: 0.05, roughness: 0.6 },
  { id: 'rubber', color: '#3a3a3c', metallic: 0, roughness: 0.95 },
  { id: 'glass', color: '#bcd4dc', metallic: 0.1, roughness: 0.05 },
  { id: 'wood-oak', color: '#9a7048', metallic: 0, roughness: 0.8 },
] as const;

export const CAD_MATERIAL_IDS: readonly string[] = CAD_MATERIALS.map((m) => m.id);

const byId = new Map(CAD_MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string | undefined): CadMaterial | undefined {
  return id === undefined ? undefined : byId.get(id);
}

/** Resolve a solid's effective paint: `materialId` (catalog) wins; inline
 *  color/metallic/roughness are the fallback (pre-P5 docs keep rendering). */
export function resolveMaterial(s: {
  materialId?: unknown;
  color?: unknown;
  metallic?: unknown;
  roughness?: unknown;
}): { color?: string; metallic?: number; roughness?: number; emissive?: string } {
  const lib = typeof s.materialId === 'string' ? byId.get(s.materialId) : undefined;
  if (lib) {
    return { color: lib.color, metallic: lib.metallic, roughness: lib.roughness, ...(lib.emissive ? { emissive: lib.emissive } : {}) };
  }
  return {
    ...(typeof s.color === 'string' && s.color ? { color: s.color } : {}),
    ...(typeof s.metallic === 'number' ? { metallic: s.metallic } : {}),
    ...(typeof s.roughness === 'number' ? { roughness: s.roughness } : {}),
  };
}

/** DETERMINISTIC material recommendation from a solid's label/kind — fixed
 *  keyword rules in fixed order; same input ⇒ same suggestion. */
export function recommendMaterial(label: string | undefined, kind: string | undefined): string {
  const text = (label ?? '').toLowerCase();
  const RULES: Array<[RegExp, string]> = [
    [/steel|bolt|screw|bracket|frame|beam/, 'steel'],
    [/alumin|chassis|heatsink|rail/, 'aluminum'],
    [/brass|fitting|valve/, 'brass'],
    [/copper|wire|pipe|coil/, 'copper'],
    [/gold|contact|pin/, 'gold'],
    [/rubber|seal|gasket|grip|foot/, 'rubber'],
    [/glass|lens|window|pane/, 'glass'],
    [/wood|oak|plank|board|leg|seat|shelf|table|bench/, 'wood-oak'],
    [/housing|case|cover|shell|cap|knob/, 'plastic-black'],
  ];
  for (const [re, id] of RULES) {
    if (re.test(text)) return id;
  }
  return kind === 'sphere' ? 'plastic-blue' : 'steel';
}
