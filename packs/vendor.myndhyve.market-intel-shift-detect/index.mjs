/**
 * vendor.myndhyve.market-intel-shift-detect
 *
 * Single typeId: `market-intel.shift-detect` (ADR 0174).
 *
 * The WIRED version of MyndHyve's Partial `MarketShiftDetectionService`
 * (src/core/market-intel/MarketShiftDetectionService.ts — coded, not wired). A pure,
 * DETERMINISTIC diff of two prior market-research result sets → a MarketShiftAlert.
 * No AI call, no side effects ⇒ replay/fork-safe. Follows the insights-suite
 * `variance-compute` shape (compare two run outputs) for the market-intel cohort.
 *
 * Pure-JS, Node-20 stdlib only.
 */

function str(v) { return typeof v === 'string' ? v : ''; }
function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/** Normalize a VoC record to a comparable key (tagType + a lowercased quote stem). */
function painKey(rec) {
  const tag = str(rec?.tagType || rec?.tag || 'pain').toLowerCase();
  const quote = str(rec?.quote || rec?.text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${tag}::${quote}`;
}
/** Records the caller considers "pain-like" (default: everything; filter by tag if present). */
function painRecords(set) {
  return arr(set?.records).filter((r) => {
    const t = str(r?.tagType || r?.tag).toLowerCase();
    return t === '' || t === 'pain' || t === 'objection' || t === 'desire' || t === 'trigger';
  });
}
/** A scored-angle key + score. */
function angleEntries(set) {
  const out = new Map();
  for (const a of arr(set?.angles)) {
    const key = str(a?.id || a?.name || a?.angle).toLowerCase().trim();
    const score = num(a?.score);
    if (key && score !== undefined) out.set(key, score);
  }
  return out;
}

export async function shiftDetect(ctx) {
  const i = ctx.inputs ?? {};
  const prev = i.previous && typeof i.previous === 'object' ? i.previous : {};
  const curr = i.current && typeof i.current === 'object' ? i.current : {};

  // ── pain-point set diff ──
  const prevPains = new Map(painRecords(prev).map((r) => [painKey(r), r]));
  const currPains = new Map(painRecords(curr).map((r) => [painKey(r), r]));
  const newPains = [];
  const intensifiedPains = [];
  for (const [k, r] of currPains) {
    if (!prevPains.has(k)) newPains.push({ tagType: str(r?.tagType || r?.tag || 'pain'), quote: str(r?.quote || r?.text) });
    else {
      const pc = num(prevPains.get(k)?.confidence);
      const cc = num(r?.confidence);
      if (pc !== undefined && cc !== undefined && cc - pc >= 0.15) intensifiedPains.push({ tagType: str(r?.tagType || 'pain'), quote: str(r?.quote || r?.text), delta: Math.round((cc - pc) * 100) / 100 });
    }
  }
  const resolvedPains = [];
  for (const [k, r] of prevPains) if (!currPains.has(k)) resolvedPains.push({ tagType: str(r?.tagType || r?.tag || 'pain'), quote: str(r?.quote || r?.text) });

  // ── angle-score deltas ──
  const prevAngles = angleEntries(prev);
  const currAngles = angleEntries(curr);
  const angleDeltas = [];
  for (const [k, score] of currAngles) {
    const before = prevAngles.get(k);
    if (before !== undefined && Math.abs(score - before) >= 0.01) {
      angleDeltas.push({ angle: k, before, after: score, delta: Math.round((score - before) * 100) / 100 });
    }
  }
  angleDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const hasShift = newPains.length > 0 || resolvedPains.length > 0 || intensifiedPains.length > 0 || angleDeltas.length > 0;
  const parts = [];
  if (newPains.length) parts.push(`${newPains.length} new pain point(s)`);
  if (resolvedPains.length) parts.push(`${resolvedPains.length} resolved`);
  if (intensifiedPains.length) parts.push(`${intensifiedPains.length} intensifying`);
  if (angleDeltas.length) parts.push(`${angleDeltas.length} angle-score shift(s)`);
  const summary = hasShift ? `Market shift detected: ${parts.join(', ')}.` : 'No material market shift since the prior research run.';

  return {
    status: 'success',
    outputs: {
      alert: {
        newPains: newPains.slice(0, 100),
        resolvedPains: resolvedPains.slice(0, 100),
        intensifiedPains: intensifiedPains.slice(0, 100),
        angleDeltas: angleDeltas.slice(0, 100),
        summary,
        hasShift,
      },
    },
  };
}

export const nodes = {
  'market-intel.shift-detect': shiftDetect,
};
