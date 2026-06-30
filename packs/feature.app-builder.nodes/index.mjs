/**
 * feature.app-builder.nodes — the producer for ADR 0153 Phase 2 app-builder canvases.
 * The `render` node normalizes a requested app design into the `canvas.app-builder`
 * shape ({ name, screens[], connectors[] }) and emits the typed `{ artifact }` output
 * envelope (ADR 0055/0083): the host run-output producer persists it as a renderable
 * artifact, and the chat workbench's app-builder renderer shows it inline.
 *
 * Components reference the host app-builder catalog by `type`; the model is told the
 * closed component set in the agent prompt, and the host validates the tree against
 * the catalog on the editor save path (closed-world). This node does structural
 * normalization + fail-fast so a malformed design never persists as an empty render.
 *
 * Pure-JS, Node-20 stdlib only. No host capability.
 */

function fail(message) {
  return Object.assign(new Error(message), { code: 'validation_error' });
}

function safeParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function str(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return max && t.length > max ? t.slice(0, max) : t;
}

/** Normalize one component node (recursive). Keeps only { type, props?, children? }
 *  — the closed canvas.app-builder shape; unknown keys are dropped. */
function normalizeComponent(raw, depth) {
  if (depth > 20) throw fail('component tree too deep (max 20)');
  if (!raw || typeof raw !== 'object') throw fail('component is not an object');
  const type = str(raw.type, 80);
  if (!type) throw fail('every component needs a string `type`');
  const out = { type };
  if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) out.props = raw.props;
  if (Array.isArray(raw.children) && raw.children.length) {
    out.children = raw.children.slice(0, 200).map((c) => normalizeComponent(c, depth + 1));
  }
  return out;
}

function normalizeScreen(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`screen ${index} is not an object`);
  const id = str(raw.id, 80) ?? `screen-${index + 1}`;
  const name = str(raw.name, 120) ?? id;
  const out = { id, name };
  const route = str(raw.route, 200); if (route) out.route = route;
  if (raw.isInitial === true) out.isInitial = true;
  if (Array.isArray(raw.components)) out.components = raw.components.slice(0, 200).map((c) => normalizeComponent(c, 0));
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const appIn = (i.app && typeof i.app === 'object') ? i.app : safeParse(i.source) ?? i;

  const name = str(appIn.name, 200);
  if (!name) throw fail('`name` is required (the app name)');
  const screensIn = Array.isArray(appIn.screens) ? appIn.screens : null;
  if (!screensIn || screensIn.length === 0) throw fail('`screens` is required — a non-empty array');
  if (screensIn.length > 60) throw fail('an app may have at most 60 screens');

  const payload = { name, screens: screensIn.map(normalizeScreen) };
  const description = str(appIn.description, 2000); if (description) payload.description = description;
  if (typeof appIn.theme === 'string' && ['default', 'light', 'dark'].includes(appIn.theme)) payload.theme = appIn.theme;

  if (Array.isArray(appIn.connectors)) {
    const screenIds = new Set(payload.screens.map((s) => s.id));
    const connectors = [];
    for (const c of appIn.connectors.slice(0, 200)) {
      const from = str(c?.from, 80); const to = str(c?.to, 80);
      // Drop connectors that don't reference real screens (no dangling edges).
      if (!from || !to || !screenIds.has(from) || !screenIds.has(to)) continue;
      const conn = { from, to };
      if (typeof c.trigger === 'string' && ['click', 'submit', 'load'].includes(c.trigger)) conn.trigger = c.trigger;
      const label = str(c.label, 120); if (label) conn.label = label;
      connectors.push(conn);
    }
    if (connectors.length) payload.connectors = connectors;
  }

  return {
    status: 'success',
    outputs: {
      screenCount: payload.screens.length,
      artifact: {
        artifactTypeId: 'canvas.app-builder',
        payload,
        title: name,
      },
    },
  };
}

export const nodes = {
  'feature.app-builder.nodes.render': render,
};
