/**
 * vendor.myndhyve.ads-platforms — ads.platform.specs executor.
 *
 * Lifts MyndHyve's PlatformSpecRegistry + the 9 per-platform spec
 * data files (amazon, google, linkedin, meta, pinterest, reddit,
 * snapchat, tiktok, x) into one self-contained pack. Since ADR 0946 P1
 * the data is the openwop-app channel spec table, carried here as a
 * generated copy (contentRules.generated.mjs).
 *
 * Pure data + lookup. No host capabilities, no AI, no external calls.
 *
 * Only `getSpecSet(platforms, placements?)` is invoked by the
 * executor — the helper namespace (getSpecForPlacement, validateText,
 * getSafeZones, getMostRestrictiveLimits, getCharacterCountState,
 * getCaptionGuidance, getAudioGuidance) are NOT exposed since they
 * have no caller in the wrapping `ads.platform.specs` node. Future
 * pack PRs that need them can either bundle their own copy of the
 * data OR depend on this pack via `dependencies` once openwop adds
 * inter-pack import support.
 */

import { AD_SPECS } from './contentRules.generated.mjs';

function makeLog(ctx) {
  const fn = typeof ctx?.log === 'function' ? ctx.log : null;
  return {
    info: (msg, data) => { if (fn) fn('info', msg, data); },
    debug: (msg, data) => { if (fn) fn('debug', msg, data); },
    warn: (msg, data) => { if (fn) fn('warn', msg, data); },
    error: (msg, data) => { if (fn) fn('error', msg, data); },
  };
}

// ─── REGISTRY (ADR 0946 P1) ──────────────────────────────
// The platform data (formerly ~1450 lines inlined here) is the ONE host
// channel spec table (backend/typescript/src/host/contentRules/channelSpecs.json),
// read through a generated copy. Media, CTA and safe-zone facets are the
// MyndHyve values verbatim. Each text limit's `max` is the platform's official
// hard limit where one is published, else the unsourced MyndHyve value, and
// `recommended` is the sourced guideline. The table records which is which.
// Edit the table, then run scripts/gen-content-rules.mjs.
const ALL_SPECS = AD_SPECS;

const specsByPlacement = new Map();
const specsByPlatform = new Map();
for (const spec of ALL_SPECS) {
  specsByPlacement.set(spec.placement, spec);
  const existing = specsByPlatform.get(spec.platform) || [];
  existing.push(spec);
  specsByPlatform.set(spec.platform, existing);
}

function getSpecSet(platforms, placements) {
  const platformsArr = Array.isArray(platforms) ? platforms : [];
  let specs;
  if (Array.isArray(placements) && placements.length > 0) {
    specs = placements
      .map((p) => specsByPlacement.get(p))
      .filter((s) => s !== undefined);
  } else {
    specs = platformsArr.flatMap((p) => specsByPlatform.get(p) || []);
  }
  return { platforms: platformsArr, specs };
}

// ─── EXECUTOR ───────────────────────────────────────────

export async function platformSpecs(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!Array.isArray(inputs.platforms)) {
    return {
      status: 'error',
      error: { code: 'INVALID_INPUTS', message: 'platforms[] required', retryable: false },
    };
  }
  log.info('Resolving platform specs', {
    platforms: inputs.platforms,
    placementsCount: Array.isArray(inputs.placements) ? inputs.placements.length : 0,
  });
  const specSet = getSpecSet(inputs.platforms, inputs.placements);
  return {
    status: 'success',
    outputs: { specSet, specCount: specSet.specs.length, success: true },
  };
}

export const nodes = {
  'ads.platform.specs': platformSpecs,
};

export default nodes;
