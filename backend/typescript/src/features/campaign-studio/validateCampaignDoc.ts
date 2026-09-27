/**
 * Editor-doc validation for `canvas.campaign` working copies (ADR 0310 Phase C).
 * A PURE mirror of the artifact schema's hard caps (artifactTypes.ts — name
 * required, 1..40 channels, ≤12 funnel stages, ≤60 assets, closed enums and
 * per-field length caps). Positional elements — no identity fields. Hard
 * errors → 422. SOFT warnings (ADR 0727 D1) for a dangling `asset.channel`: the save
 * succeeds and the warning rides back on the ADR 0305 Phase C lane.
 */

export interface CampaignValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

// Exported so the agent-prompt parity test can pin prompts/campaign-strategist.md
// to this closed world (XCH-CS-1, LLM-EXCHANGE-AUDIT Wave 3).
export const CAMPAIGN_CHANNEL_TYPES = ['email', 'social', 'search', 'display', 'content', 'sms', 'events', 'pr'] as const;
export const CAMPAIGN_STAGES = ['awareness', 'consideration', 'conversion', 'retention', 'advocacy'] as const;
const CHANNEL_TYPES = new Set<string>(CAMPAIGN_CHANNEL_TYPES);
const STAGES = new Set<string>(CAMPAIGN_STAGES);

// Grade pass GC-CV-9: the collection caps as NAMED constants (were inline
// literals), mirroring the artifact schema + pinned by capParity.test.ts.
export const MAX_CHANNELS = 40;
export const MAX_FUNNEL_STAGES = 12;
export const MAX_ASSETS = 60;

const strCap = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;

export function validateCampaignDoc(state: Record<string, unknown>): CampaignValidation {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };
  // ADR 0727 D1 — soft cross-facet warnings ride the ADR 0305 Phase C lane: errors reject
  // the write (422), warnings SAVE and report (`canvasEditorRoutes.ts:344` → the editor's
  // `savedWithWarnings` toast). Campaign Studio is the lane's second emitter after
  // `validateAppDoc`'s missing-screen/source/connector references.
  const warnings: { path: string; message: string }[] = [];
  const warn = (path: string, message: string): void => { warnings.push({ path, message }); };

  if (typeof state.name !== 'string' || !state.name || state.name.length > 200) {
    err('name', 'name is required (a string of 1–200 characters)');
  }
  if (state.objective !== undefined && !strCap(state.objective, 600)) err('objective', 'objective must be a string of at most 600 characters');
  if (state.audience !== undefined && !strCap(state.audience, 600)) err('audience', 'audience must be a string of at most 600 characters');

  // Collected while validating channels, then used for the ADR 0727 D1 asset→channel
  // reference check. Only VALID names go in: an invalid channel already errored, and
  // warning about an asset that points at it would be noise on top of a hard failure.
  const channelNames = new Set<string>();
  const channels = state.channels;
  if (!Array.isArray(channels) || channels.length === 0) {
    err('channels', 'a campaign needs at least one channel');
  } else {
    if (channels.length > MAX_CHANNELS) err('channels', `a campaign holds at most ${MAX_CHANNELS} channels`);
    channels.forEach((raw, i) => {
      const path = `channels[${i}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err(path, 'each channel must be an object'); return; }
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== 'string' || !c.name || c.name.length > 120) err(`${path}.name`, 'channel name is required (1–120 characters)');
      else channelNames.add(c.name);
      if (typeof c.type !== 'string' || !CHANNEL_TYPES.has(c.type)) err(`${path}.type`, `channel type must be one of: ${[...CHANNEL_TYPES].join(', ')}`);
      if (c.tactic !== undefined && !strCap(c.tactic, 400)) err(`${path}.tactic`, 'tactic must be a string of at most 400 characters');
      if (c.budget !== undefined && (typeof c.budget !== 'number' || !Number.isFinite(c.budget) || c.budget < 0)) err(`${path}.budget`, 'budget must be a non-negative number');
      for (const k of Object.keys(c)) if (!['name', 'type', 'tactic', 'budget'].includes(k)) err(`${path}.${k}`, `unknown channel field '${k}'`);
    });
  }

  const funnel = state.funnel;
  if (funnel !== undefined) {
    if (!Array.isArray(funnel) || funnel.length > MAX_FUNNEL_STAGES) {
      err('funnel', `funnel holds at most ${MAX_FUNNEL_STAGES} stages`);
    } else {
      funnel.forEach((raw, i) => {
        const path = `funnel[${i}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err(path, 'each stage must be an object'); return; }
        const s = raw as Record<string, unknown>;
        if (typeof s.stage !== 'string' || !STAGES.has(s.stage)) err(`${path}.stage`, `stage must be one of: ${[...STAGES].join(', ')}`);
        if (s.description !== undefined && !strCap(s.description, 600)) err(`${path}.description`, 'description must be a string of at most 600 characters');
        if (s.kpis !== undefined && (!Array.isArray(s.kpis) || s.kpis.length > 8 || s.kpis.some((k) => !strCap(k, 120)))) {
          err(`${path}.kpis`, 'kpis must be at most 8 strings of at most 120 characters each');
        }
        // ADR 0360 — optional funnel-board positions (host-owned additive;
        // clamped to the board extent, the ADR 0323 screen-x/y precedent).
        for (const axis of ['x', 'y'] as const) {
          const v = s[axis];
          if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 4000)) {
            err(`${path}.${axis}`, `${axis} must be a finite number between 0 and 4000`);
          }
        }
        for (const k of Object.keys(s)) if (!['stage', 'description', 'kpis', 'x', 'y'].includes(k)) err(`${path}.${k}`, `unknown stage field '${k}'`);
      });
    }
  }

  const assets = state.assets;
  if (assets !== undefined) {
    if (!Array.isArray(assets) || assets.length > MAX_ASSETS) {
      err('assets', `assets holds at most ${MAX_ASSETS} entries`);
    } else {
      const caps: Record<string, number> = { channel: 120, format: 80, headline: 240, body: 2000, cta: 120 };
      assets.forEach((raw, i) => {
        const path = `assets[${i}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err(path, 'each asset must be an object'); return; }
        const a = raw as Record<string, unknown>;
        for (const [k, v] of Object.entries(a)) {
          if (!(k in caps)) { err(`${path}.${k}`, `unknown asset field '${k}'`); continue; }
          if (!strCap(v, caps[k]!)) err(`${path}.${k}`, `${k} must be a string of at most ${caps[k]} characters`);
        }
        // ADR 0727 D1 (CSC-1) — an asset names its channel by DISPLAY LABEL, so a rename or
        // a removal orphans it silently. A WARNING, never an error: matching is by label, a
        // mid-edit rename is a normal state, and existing docs must keep saving. An absent or
        // empty `channel` is an unassigned asset — legitimate, never warned.
        if (typeof a.channel === 'string' && a.channel && !channelNames.has(a.channel)) {
          warn(`${path}.channel`, `references missing channel '${a.channel}'`);
        }
      });
    }
  }

  for (const key of Object.keys(state)) {
    if (!['name', 'objective', 'audience', 'channels', 'funnel', 'assets'].includes(key)) {
      err(key, `unknown campaign field '${key}'`);
    }
  }

  return { errors, warnings };
}
