/**
 * App-builder screen operations — a thin typed adapter over the canvas
 * framework's `frameOps` factory (ADR 0310 Phase A; the logic moved verbatim
 * from here to `canvas/frameOps.ts`, where it originated as ADR 0305 Phase B).
 * The app-builder specifics live in the trait config: screens under `screens`,
 * the single-`isInitial` home flag, the `/{id}` route stamp, and the
 * connector delete-cascade.
 */
import { frameOps } from '../../canvas/frameOps.js';
import type { CompNode, Screen } from './canvasTree.js';

// ADR 0323 — screen-flow edge presentation (all optional, additive).
export type ConnectorEdge = 'top' | 'right' | 'bottom' | 'left';
export type ConnectorTransition = 'push' | 'replace' | 'modal' | 'fade' | 'slide' | 'none';
export type ConnectorRouting = 'bezier' | 'orthogonal' | 'straight' | 'step';
export interface Connector {
  from: string; to: string; trigger?: string; label?: string;
  sourceEdge?: ConnectorEdge; targetEdge?: ConnectorEdge;
  transition?: ConnectorTransition; routingStyle?: ConnectorRouting; animated?: boolean;
}
// ADR 0342 Phase 0 — the schema facets the editor round-trip must PRESERVE
// (they were dropped by coerceApp before: DS-01/DA-01 — saving lost them).
export interface AppThemeColors { primary?: string; secondary?: string }
export interface AppDataSource { id: string; name?: string; fields?: string[]; rows?: Record<string, unknown>[] }
// ADR 0343 — the comprehensive application document (all additive/optional).
// The backend owns validation (`validateAppDoc`); the editor's job here is to
// carry every facet through load→edit→save without loss. Shapes are typed
// loosely on purpose — the Phase-2 inspector panels narrow them where edited.
export interface AppResourceRef { id: string; mode?: 'linked' | 'detached' }
export interface AppStateVariable { id: string; label?: string; type: 'string' | 'number' | 'boolean' | 'list'; initial?: unknown }
export interface AppModelField { name: string; type: string; required?: boolean; default?: unknown; referenceTo?: string; validation?: Record<string, unknown> }
export interface AppModel { id: string; name: string; fields: AppModelField[]; relationships?: { to: string; kind: string; name?: string }[] }
export interface AppOperation {
  id: string; name: string; kind: string; purpose?: string; modelId?: string;
  input?: { name: string; type: string; required?: boolean }[];
  output?: { type: string; fields?: { name: string; type: string }[] };
  auth?: string; role?: string; adapterRef?: string;
  mock?: { status: string; rows?: Record<string, unknown>[]; message?: string };
  errors?: { code: string; message?: string }[];
}
export interface AppAuthProfile { kind?: string; roles?: string[]; guards?: { screenId: string; requiresRole?: string; redirectTo?: string }[] }
export interface AppEnvRequirement { key: string; purpose: string; requiredFor?: string[] }
export interface AppSharePolicy { sampleData?: 'redact' | 'include'; perSource?: Record<string, boolean> }
export interface AppComponentDefinition { id: string; name: string; root: CompNode }
export interface AppDoc {
  name: string;
  description?: string;
  theme?: string;
  themeColors?: AppThemeColors;
  schemaVersion?: number;
  designSystemRef?: AppResourceRef;
  brandRef?: AppResourceRef;
  screens: Screen[];
  connectors?: Connector[];
  dataSources?: AppDataSource[];
  stateVariables?: AppStateVariable[];
  models?: AppModel[];
  operations?: AppOperation[];
  authProfile?: AppAuthProfile;
  envRequirements?: AppEnvRequirement[];
  componentDefinitions?: AppComponentDefinition[];
  sharePolicy?: AppSharePolicy;
}

/** Schema cap (artifactTypes.ts caps screens at 60 server-side too). */
export const MAX_SCREENS = 60;

const ops = frameOps<AppDoc, Screen>({
  key: 'screens',
  max: MAX_SCREENS,
  homeFlag: 'isInitial',
  slugFallback: 'screen',
  makeFrame: (id, name) => ({ id, name, route: `/${id}`, components: [] }),
  restamp: (screen, id) => {
    screen.route = `/${id}`;
  },
  cascade: (app, removedId) => {
    if (app.connectors) {
      app.connectors = app.connectors.filter((c) => c.from !== removedId && c.to !== removedId);
    }
  },
});

/** The frames-trait instance the app-builder's CanvasTypeDefinition carries. */
export const appBuilderFrameOps = ops;

/** A deterministic unique screen id derived from the name — no clock/random. */
export const nextScreenId = (screens: Screen[], name: string): string => ops.nextFrameId(screens, name);

/** Append a new empty screen. Returns its index, or -1 at the MAX_SCREENS cap. */
export const addScreen = (app: AppDoc, name: string): number => ops.addFrame(app, name);

/** Rename a screen (display name only — the id, and connectors keyed on it, stay stable). */
export const renameScreen = (app: AppDoc, index: number, name: string): void => ops.renameFrame(app, index, name);

/** Deep-clone the screen at `index` and insert it right after (never the home screen). */
export const duplicateScreen = (app: AppDoc, index: number): number => ops.duplicateFrame(app, index);

/** Delete the screen at `index` — last-screen guard, connector cascade, home reassignment. */
export const deleteScreen = (app: AppDoc, index: number): boolean => ops.deleteFrame(app, index);

/** Move the screen at `index` to `toIndex` (clamped). */
export const reorderScreen = (app: AppDoc, index: number, toIndex: number): void => ops.reorderFrame(app, index, toIndex);

/** Make the screen at `index` the single home screen. */
export const setHomeScreen = (app: AppDoc, index: number): void => ops.setHomeFrame(app, index);

/** Instantiate a screen TEMPLATE (ADR 0305 Phase F) as a new screen. */
export const addScreenFromTemplate = (app: AppDoc, template: { name: string; components: CompNode[] }): number =>
  ops.addFrameFromTemplate(app, { name: template.name, content: { components: template.components } });

/** ADR 0347 5a — instantiate a kit (screens + connectors) into the ONE doc:
 *  collision-safe id remap (the frames factory owns id uniqueness), navigation
 *  + connector remap, and a vertical offset below the existing flow so the
 *  inserted screens never land on top of it. ONE history commit (the caller
 *  wraps this in editDoc). Returns `false` (doc untouched) when the insert
 *  would exceed the MAX_SCREENS validator cap — otherwise the failure only
 *  surfaces as a save-time 422 (grade pass 2026-07-11 AB-CODE-F4). */
export function insertKitContent(app: AppDoc, kit: { screens: Record<string, unknown>[]; connectors?: Record<string, unknown>[] }): boolean {
  if (app.screens.length + kit.screens.length > MAX_SCREENS) return false;
  const existing = new Set(app.screens.map((s) => s.id));
  const idMap = new Map<string, string>();
  const offsetY = app.screens.length
    ? Math.max(...app.screens.map((s) => (typeof s.y === 'number' ? s.y : 0))) + 520
    : 0;
  for (const raw of kit.screens) {
    const screen = JSON.parse(JSON.stringify(raw)) as Screen;
    const wanted = typeof screen.id === 'string' && screen.id ? screen.id : 'screen';
    let id = wanted; let n = 2;
    while (existing.has(id)) id = `${wanted}-${n++}`;
    idMap.set(wanted, id);
    screen.id = id;
    screen.route = `/${id}`;
    if (typeof screen.y === 'number') screen.y += offsetY;
    else screen.y = offsetY + 80;
    delete (screen as { isInitial?: boolean }).isInitial; // the doc already has ONE home
    existing.add(id);
    app.screens.push(screen);
  }
  // Remap navigateTo across the INSERTED trees only.
  const remapNav = (node: CompNode): void => {
    const nav = node.props?.navigateTo;
    if (typeof nav === 'string' && idMap.has(nav)) (node.props as Record<string, unknown>).navigateTo = idMap.get(nav);
    for (const c of node.children ?? []) remapNav(c);
  };
  for (const id of idMap.values()) {
    const screen = app.screens.find((s) => s.id === id);
    for (const c of screen?.components ?? []) remapNav(c);
  }
  // Connectors: remap endpoints; skip any referencing outside the kit or duplicating.
  const connectors = app.connectors ?? (app.connectors = []);
  for (const raw of kit.connectors ?? []) {
    const c = JSON.parse(JSON.stringify(raw)) as Connector;
    const from = idMap.get(c.from); const to = idMap.get(c.to);
    if (!from || !to) continue;
    c.from = from; c.to = to;
    if (connectors.some((x) => x.from === c.from && x.to === c.to)) continue;
    connectors.push(c);
  }
  return true;
}
