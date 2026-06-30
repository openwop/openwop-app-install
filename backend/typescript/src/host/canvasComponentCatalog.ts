/**
 * Canvas component catalog (ADR 0153 Phase 2 §R4) — the SINGLE source of truth for
 * "what components a canvas type may contain". Features contribute their catalog at
 * boot (`registerCanvasComponents`), exactly like the artifact-type / agent / card
 * registries; nothing edits a god-singleton (the MyndHyve anti-pattern that drifted).
 *
 * One catalog object feeds THREE consumers, so they can never disagree:
 *   (a) the canvas agent's system prompt  → `catalogPromptSchema(canvasTypeId)`
 *   (b) the editor component palette       → `listCanvasComponents(canvasTypeId)`
 *   (c) generation-time validation         → `validateComponentTree(...)`
 *
 * Generation is CLOSED-WORLD: a component whose `type` is not in the catalog is
 * rejected (`unknown_component_type`), mirroring ADR 0072's `unknown_typeid` and the
 * ADR 0051 A2UI closed catalog. The model emits typed component JSON, never code.
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.canvasCatalog');

/** One field a component exposes in the property editor. `type` drives the editor
 *  widget; the same field shape constrains what the model may set. */
export interface ComponentPropDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'longtext';
  label?: string;
  /** Allowed values when `type:'enum'`. */
  options?: readonly string[];
  default?: string | number | boolean;
  required?: boolean;
}

export interface ComponentDef {
  /** Stable component type id within the canvas type, e.g. `button`, `stack`. */
  type: string;
  label: string;
  description?: string;
  category: 'layout' | 'input' | 'display' | 'media' | 'navigation' | 'data';
  /** Whether this component may contain child components (a container). */
  acceptsChildren?: boolean;
  props?: readonly ComponentPropDef[];
}

// canvasTypeId -> (componentType -> def). Insertion order preserved for the palette.
const catalogs = new Map<string, Map<string, ComponentDef>>();

/** Contribute a canvas type's component catalog. Idempotent per (canvasTypeId,type):
 *  a later registration overwrites (with a warn), so a feature owns its own set. */
export function registerCanvasComponents(canvasTypeId: string, defs: readonly ComponentDef[]): void {
  let m = catalogs.get(canvasTypeId);
  if (!m) { m = new Map(); catalogs.set(canvasTypeId, m); }
  for (const d of defs) {
    if (m.has(d.type)) log.warn('component_overwrite', { canvasTypeId, type: d.type });
    m.set(d.type, d);
  }
  log.debug('canvas_components_registered', { canvasTypeId, count: defs.length });
}

export function listCanvasComponents(canvasTypeId: string): readonly ComponentDef[] {
  return [...(catalogs.get(canvasTypeId)?.values() ?? [])];
}

export function getCanvasComponent(canvasTypeId: string, type: string): ComponentDef | undefined {
  return catalogs.get(canvasTypeId)?.get(type);
}

export interface ComponentTreeError {
  path: string;
  code: 'unknown_component_type' | 'unknown_prop' | 'bad_prop_value' | 'illegal_children';
  message: string;
}

interface ComponentNode {
  type?: unknown;
  props?: unknown;
  children?: unknown;
}

/** Validate a component tree against a canvas type's catalog (closed-world). Returns
 *  the (possibly empty) list of violations. Unknown types, unknown/ill-typed props,
 *  and children under a non-container are all rejected — so a generated tree the
 *  editor/renderer can't honor never persists. */
export function validateComponentTree(canvasTypeId: string, nodes: unknown, basePath = 'components'): ComponentTreeError[] {
  const catalog = catalogs.get(canvasTypeId);
  const errors: ComponentTreeError[] = [];
  if (!catalog) {
    errors.push({ path: basePath, code: 'unknown_component_type', message: `no catalog registered for canvas type '${canvasTypeId}'` });
    return errors;
  }
  if (!Array.isArray(nodes)) return errors; // an absent/empty children list is valid
  nodes.forEach((raw, i) => {
    const path = `${basePath}[${i}]`;
    const node = (raw ?? {}) as ComponentNode;
    const type = typeof node.type === 'string' ? node.type : '';
    const def = catalog.get(type);
    if (!def) {
      errors.push({ path, code: 'unknown_component_type', message: `unknown component type '${type}' (not in the '${canvasTypeId}' catalog)` });
      return; // can't validate props/children without a def
    }
    if (node.props && typeof node.props === 'object' && !Array.isArray(node.props)) {
      const allowed = new Map((def.props ?? []).map((p) => [p.name, p]));
      for (const [k, val] of Object.entries(node.props as Record<string, unknown>)) {
        const pd = allowed.get(k);
        if (!pd) { errors.push({ path: `${path}.props.${k}`, code: 'unknown_prop', message: `unknown prop '${k}' on '${type}'` }); continue; }
        if (!propValueOk(pd, val)) errors.push({ path: `${path}.props.${k}`, code: 'bad_prop_value', message: `invalid value for '${k}' (expected ${pd.type}${pd.options ? ` ∈ {${pd.options.join('|')}}` : ''})` });
      }
    }
    if (node.children !== undefined && Array.isArray(node.children) && node.children.length > 0) {
      if (!def.acceptsChildren) errors.push({ path: `${path}.children`, code: 'illegal_children', message: `'${type}' is not a container` });
      else errors.push(...validateComponentTree(canvasTypeId, node.children, `${path}.children`));
    }
  });
  return errors;
}

function propValueOk(pd: ComponentPropDef, val: unknown): boolean {
  switch (pd.type) {
    case 'string': case 'longtext': case 'color': return typeof val === 'string';
    case 'number': return typeof val === 'number' && Number.isFinite(val);
    case 'boolean': return typeof val === 'boolean';
    case 'enum': return typeof val === 'string' && (pd.options ?? []).includes(val);
    default: return false;
  }
}

/** A compact, deterministic catalog description for the agent system prompt — the
 *  closed menu of legal component types + their props. Sorted for stable prompts. */
export function catalogPromptSchema(canvasTypeId: string): string {
  const defs = [...(catalogs.get(canvasTypeId)?.values() ?? [])].sort((a, b) => a.type.localeCompare(b.type));
  if (!defs.length) return '(no components registered)';
  return defs.map((d) => {
    const props = (d.props ?? []).map((p) => p.type === 'enum' ? `${p.name}:${(p.options ?? []).join('|')}` : `${p.name}:${p.type}`).join(', ');
    const kids = d.acceptsChildren ? ' [container]' : '';
    return `- ${d.type}${kids} — ${d.label}${props ? ` { ${props} }` : ''}`;
  }).join('\n');
}

/** Test-only: clear all catalogs. */
export function __resetCanvasCatalogs(): void {
  catalogs.clear();
}
