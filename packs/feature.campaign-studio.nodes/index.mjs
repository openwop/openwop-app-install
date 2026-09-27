/**
 * feature.campaign-studio.nodes — the producer for ADR 0153 Phase 3 campaign canvases.
 * The `render` node normalizes a requested campaign into the `canvas.campaign` shape
 * and emits the typed `{ artifact }` output envelope (ADR 0055/0083): the host run-output
 * producer persists it, and the chat workbench's campaign renderer shows it inline.
 *
 * Constrained typed JSON (the host artifact-type registry does the authoritative AJV
 * validation); this node does structural normalization + fail-fast. Pure-JS, Node-20.
 */

const CHANNEL_TYPES = new Set(['email', 'social', 'search', 'display', 'content', 'sms', 'events', 'pr']);
const STAGES = new Set(['awareness', 'consideration', 'conversion', 'retention', 'advocacy']);

function fail(message) { return Object.assign(new Error(message), { code: 'validation_error' }); }
function safeParse(s) { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } }
function str(v, max) { if (typeof v !== 'string') return undefined; const t = v.trim(); if (!t) return undefined; return max && t.length > max ? t.slice(0, max) : t; }

function normalizeChannel(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`channel ${index} is not an object`);
  const name = str(raw.name, 120);
  if (!name) throw fail(`channel ${index} needs a name`);
  // R2 CS-SP-2 — an unknown type used to be silently rewritten to 'content',
  // so the closed-world validator downstream never saw the bad value and the
  // tool's promised "fix and call again" repair loop never fired: a "tiktok"
  // channel returned ok:true as "content". Unknown enums are now TYPED
  // failures the model can repair.
  if (!CHANNEL_TYPES.has(raw.type)) {
    throw fail(`channel ${index} ("${name}") has unknown type "${String(raw.type)}" — use one of: ${[...CHANNEL_TYPES].join(', ')}`);
  }
  const out = { name, type: raw.type };
  const tactic = str(raw.tactic, 400); if (tactic) out.tactic = tactic;
  if (typeof raw.budget === 'number' && Number.isFinite(raw.budget) && raw.budget >= 0) out.budget = raw.budget;
  return out;
}

function normalizeStage(raw) {
  // R2 CS-SP-2 — same rule as channel type: unknown stages are typed
  // failures, never silently substituted with 'awareness'.
  if (!STAGES.has(raw?.stage)) {
    throw fail(`funnel stage has unknown value "${String(raw?.stage)}" — use one of: ${[...STAGES].join(', ')}`);
  }
  const out = { stage: raw.stage };
  const description = str(raw?.description, 600); if (description) out.description = description;
  if (Array.isArray(raw?.kpis)) { const kpis = raw.kpis.map((k) => str(k, 120)).filter(Boolean).slice(0, 8); if (kpis.length) out.kpis = kpis; }
  // R2 CS-SP-1 — the ADR 0360 board coordinates were DROPPED here, so every
  // agent revision of an existing campaign silently reset the user's board
  // arrangement to the auto-grid (even though get-design had returned the
  // positions). Preserve them when finite.
  if (typeof raw?.x === 'number' && Number.isFinite(raw.x)) out.x = raw.x;
  if (typeof raw?.y === 'number' && Number.isFinite(raw.y)) out.y = raw.y;
  return out;
}

function normalizeAsset(raw) {
  const out = {};
  const channel = str(raw?.channel, 120); if (channel) out.channel = channel;
  const format = str(raw?.format, 80); if (format) out.format = format;
  const headline = str(raw?.headline, 240); if (headline) out.headline = headline;
  const body = str(raw?.body, 2000); if (body) out.body = body;
  const cta = str(raw?.cta, 120); if (cta) out.cta = cta;
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const c = (i.campaign && typeof i.campaign === 'object') ? i.campaign : safeParse(i.source) ?? i;

  const name = str(c.name, 200);
  if (!name) throw fail('`name` is required (the campaign name)');
  const channelsIn = Array.isArray(c.channels) ? c.channels : null;
  if (!channelsIn || channelsIn.length === 0) throw fail('`channels` is required — a non-empty array');

  const payload = { name, channels: channelsIn.slice(0, 40).map(normalizeChannel) };
  const objective = str(c.objective, 600); if (objective) payload.objective = objective;
  const audience = str(c.audience, 600); if (audience) payload.audience = audience;
  if (Array.isArray(c.funnel)) { const funnel = c.funnel.slice(0, 12).map(normalizeStage); if (funnel.length) payload.funnel = funnel; }
  if (Array.isArray(c.assets)) { const assets = c.assets.slice(0, 60).map(normalizeAsset).filter((a) => Object.keys(a).length); if (assets.length) payload.assets = assets; }

  return {
    status: 'success',
    outputs: {
      channelCount: payload.channels.length,
      artifact: { artifactTypeId: 'canvas.campaign', payload, title: name },
    },
  };
}

export const nodes = { 'feature.campaign-studio.nodes.render': render };
