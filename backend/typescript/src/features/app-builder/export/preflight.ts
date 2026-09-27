/**
 * Export preflight (ADR 0348 6b — PR-08). Compares the DOCUMENT's used
 * semantics against the target's capability manifest and reports what the
 * generated code will NOT carry — the anti-"silently dropped behavior"
 * contract. Pure + deterministic; the route surfaces notes additively and
 * blocks only under explicit `strict`.
 */
import { GENERATOR_CAPABILITIES } from './capabilityManifest.js';
import type { ExportTarget } from './generators.js';

export interface PreflightNote {
  code: string;
  message: string;
  count?: number;
}

interface NodeIn { type?: unknown; props?: Record<string, unknown>; children?: unknown; actions?: unknown; bindings?: unknown }

function walk(nodes: unknown, visit: (n: NodeIn) => void, depth = 0): void {
  if (depth > 25 || !Array.isArray(nodes)) return;
  for (const n of nodes as NodeIn[]) {
    if (!n || typeof n !== 'object') continue;
    visit(n);
    walk(n.children, visit, depth + 1);
  }
}

export function preflightExport(state: Record<string, unknown>, target: ExportTarget): PreflightNote[] {
  const m = GENERATOR_CAPABILITIES[target];
  const notes: PreflightNote[] = [];
  const screens = Array.isArray(state.screens) ? state.screens : [];

  let actionCount = 0;
  let bindingCount = 0;
  const responsiveUsed = new Set<string>();
  for (const s of screens) {
    walk((s as { components?: unknown }).components, (n) => {
      if (Array.isArray(n.actions) && n.actions.length) actionCount += n.actions.length;
      if (n.bindings && typeof n.bindings === 'object' && !Array.isArray(n.bindings)) bindingCount += Object.keys(n.bindings).length;
      const hide = n.props?.hideOn;
      if (hide === 'mobile' || hide === 'desktop') responsiveUsed.add('hideOn');
      if (n.props?.columnsMobile !== undefined) responsiveUsed.add('columnsMobile');
    });
  }

  if (actionCount && m.actionKinds.length === 0) {
    notes.push({ code: 'actions_not_generated', count: actionCount, message: `${actionCount} closed action(s) will not execute in ${target} output (only tap navigation is generated).` });
  }
  if (bindingCount && m.bindingPathRoots.length === 0) {
    notes.push({ code: 'bindings_not_generated', count: bindingCount, message: `${bindingCount} binding(s) resolve only in the preview — ${target} output renders sample data.` });
  }
  for (const facet of ['models', 'operations', 'authProfile', 'envRequirements'] as const) {
    const present = facet === 'authProfile' ? Boolean(state.authProfile) : Array.isArray(state[facet]) && (state[facet] as unknown[]).length > 0;
    if (present && !m.appContract.includes(facet)) {
      notes.push({ code: `${facet}_not_generated`, message: `The design's ${facet} are not scaffolded by the ${target} generator (design-time contract only).` });
    }
  }
  for (const r of responsiveUsed) {
    if (!m.responsive.includes(r as 'hideOn' | 'columnsMobile')) {
      notes.push({ code: `${r}_not_generated`, message: `'${r}' has no ${target} mapping — affected components render unconditionally.` });
    }
  }
  return notes;
}
