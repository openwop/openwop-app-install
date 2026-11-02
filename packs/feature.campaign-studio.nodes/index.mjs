/**
 * feature.campaign-studio.nodes — the producer for ADR 0153 Phase 3 campaign canvases.
 * The `render` node normalizes a requested campaign into the `canvas.campaign` shape
 * and emits the typed `{ artifact }` output envelope (ADR 0055/0083): the host run-output
 * producer persists it, and the chat workbench's campaign renderer shows it inline.
 *
 * Constrained typed JSON (the host artifact-type registry does the authoritative AJV
 * validation, and the render tool runs `validateCampaignDoc`); this node trims and
 * fails fast on unknown enums, and otherwise passes every value through unchanged
 * so those validators are the single judge (ADR 1020 D15). Pure-JS, Node-20.
 */

const CHANNEL_TYPES = new Set(['email', 'social', 'search', 'display', 'content', 'sms', 'events', 'pr']);
const STAGES = new Set(['awareness', 'consideration', 'conversion', 'retention', 'advocacy']);

function fail(message) { return Object.assign(new Error(message), { code: 'validation_error' }); }
function safeParse(s) { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } }
/** Trim a string; '' and non-strings read as absent. ADR 1020 D15 (CS70WF-25): it
 *  NEVER truncates — an over-long value reaches `validateCampaignDoc` (and the
 *  artifact schema) as written, so the model is told and can repair it. */
function str(v) { if (typeof v !== 'string') return undefined; const t = v.trim(); return t ? t : undefined; }

/** Copy the fields a validator must see, unchanged except for trimming: known fields
 *  normalized, every OTHER field carried through so the closed-world check rejects it.
 *  (This node used to rebuild objects field by field, so an unknown field, an
 *  over-long value or an invalid budget vanished and the model got ok:true.) */
function passThrough(raw, known) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (known.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** A trimmed text field when it is text; a non-string is passed through so the
 *  validator names it (grade-code M6); blank text reads as absent. */
function keepText(out, key, v) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') { out[key] = v; return; }
  const t = v.trim();
  if (t) out[key] = t;
}

function normalizeChannel(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`channel ${index} is not an object`);
  const name = str(raw.name);
  if (!name) throw fail(`channel ${index} needs a name`);
  // R2 CS-SP-2 — unknown enums are TYPED failures the model can repair (an unknown
  // type used to be silently rewritten to 'content').
  if (!CHANNEL_TYPES.has(raw.type)) {
    throw fail(`channel ${index} ("${name}") has unknown type "${String(raw.type)}" — use one of: ${[...CHANNEL_TYPES].join(', ')}`);
  }
  const out = { name, type: raw.type };
  keepText(out, 'tactic', raw.tactic);
  // ADR 1020 D15 — an invalid budget is passed on (and rejected by the validator),
  // never silently dropped.
  if (raw.budget !== undefined && raw.budget !== null) out.budget = raw.budget;
  return { ...out, ...passThrough(raw, ['name', 'type', 'tactic', 'budget']) };
}

function normalizeStage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('each funnel stage must be an object');
  // R2 CS-SP-2 — same rule as channel type: unknown stages are typed failures.
  if (!STAGES.has(raw.stage)) {
    throw fail(`funnel stage has unknown value "${String(raw.stage)}" — use one of: ${[...STAGES].join(', ')}`);
  }
  const out = { stage: raw.stage };
  keepText(out, 'description', raw.description);
  if (Array.isArray(raw.kpis)) { const kpis = raw.kpis.map((k) => (typeof k === 'string' ? k.trim() : k)).filter((k) => k !== ''); if (kpis.length) out.kpis = kpis; }
  else if (raw.kpis !== undefined) out.kpis = raw.kpis;
  // R2 CS-SP-1 — the ADR 0360 board coordinates are preserved (the validator checks range).
  if (raw.x !== undefined) out.x = raw.x;
  if (raw.y !== undefined) out.y = raw.y;
  return { ...out, ...passThrough(raw, ['stage', 'description', 'kpis', 'x', 'y']) };
}

function normalizeAsset(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`asset ${index} is not an object`);
  const out = {};
  for (const k of ['channel', 'format', 'headline', 'body', 'cta']) { const v = str(raw[k]); if (v) out[k] = v; else if (raw[k] !== undefined && typeof raw[k] !== 'string') out[k] = raw[k]; }
  return { ...out, ...passThrough(raw, ['channel', 'format', 'headline', 'body', 'cta']) };
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const c = (i.campaign && typeof i.campaign === 'object') ? i.campaign : safeParse(i.source) ?? i;

  const name = str(c.name);
  if (!name) throw fail('`name` is required (the campaign name)');
  const channelsIn = Array.isArray(c.channels) ? c.channels : null;
  if (!channelsIn || channelsIn.length === 0) throw fail('`channels` is required — a non-empty array');

  // ADR 1020 D15 — no `.slice` caps: an over-cap list reaches the closed-world
  // validator, which names it. An asset with no content at all (`{}`, or only
  // blank strings) is dropped, as it always was: there is nothing in it to save.
  const payload = { name, channels: channelsIn.map(normalizeChannel) };
  keepText(payload, 'objective', c.objective);
  keepText(payload, 'audience', c.audience);
  if (Array.isArray(c.funnel)) { const funnel = c.funnel.map(normalizeStage); if (funnel.length) payload.funnel = funnel; }
  else if (c.funnel !== undefined) payload.funnel = c.funnel;
  if (Array.isArray(c.assets)) { const assets = c.assets.map(normalizeAsset).filter((a) => Object.keys(a).length > 0); if (assets.length) payload.assets = assets; }
  else if (c.assets !== undefined) payload.assets = c.assets;
  // Top-level fields the campaign shape does not know are carried, so the validator
  // refuses them (a flat input's own port names are not campaign fields).
  for (const [k, v] of Object.entries(c)) {
    if (CAMPAIGN_KEYS.includes(k) || (c === i && INPUT_KEYS.includes(k))) continue;
    payload[k] = v;
  }

  return {
    status: 'success',
    outputs: {
      channelCount: payload.channels.length,
      artifact: { artifactTypeId: 'canvas.campaign', payload, title: name },
    },
  };
}

/** The campaign's own top-level fields (`validateCampaignDoc`'s closed world). */
const CAMPAIGN_KEYS = ['name', 'objective', 'audience', 'channels', 'funnel', 'assets'];
/** Node input ports that are not campaign fields when the campaign is passed flat. */
const INPUT_KEYS = ['campaign', 'source', 'provider', 'model', 'canvasId', 'baseVersion'];

export const nodes = { 'feature.campaign-studio.nodes.render': render };
