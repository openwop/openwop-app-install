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
  const type = CHANNEL_TYPES.has(raw.type) ? raw.type : 'content';
  const out = { name, type };
  const tactic = str(raw.tactic, 400); if (tactic) out.tactic = tactic;
  if (typeof raw.budget === 'number' && Number.isFinite(raw.budget) && raw.budget >= 0) out.budget = raw.budget;
  return out;
}

function normalizeStage(raw) {
  const stage = STAGES.has(raw?.stage) ? raw.stage : 'awareness';
  const out = { stage };
  const description = str(raw?.description, 600); if (description) out.description = description;
  if (Array.isArray(raw?.kpis)) { const kpis = raw.kpis.map((k) => str(k, 120)).filter(Boolean).slice(0, 8); if (kpis.length) out.kpis = kpis; }
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
