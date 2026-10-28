/**
 * ADR 0951 P1 — the heat beacon's input contract. Closed-world: a batch is at most
 * 50 events of three kinds, every number is range-checked, and the only strings
 * that can reach a stored key are a normalized page key and author-given element
 * or section ids in a markup-safe alphabet (no free text, no URLs with queries).
 * Anything else is a typed 400 naming the field — never a silent partial record.
 */
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { DEVICE_CLASSES, gridCell, sectionKey, selectorCell, type DeviceClass, type HeatEvent } from './heatStore.js';
import { HEATMAPS_TOGGLE } from './replayStore.js';

export const HEAT_BATCH_MAX = 50;

/** Whether the tenant collects heat data (the parent `analytics` toggle is checked
 *  by the caller's route gate). Fail-closed on a read error. */
export async function heatmapsEnabled(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(HEATMAPS_TOGGLE, { tenantId }).catch(() => null))?.enabled);
}

/** A page key: the page's path or slug, query and fragment stripped, ≤ 200 chars,
 *  no whitespace or control characters. `null` when unusable. */
export function normalizePageKey(raw: string): string | null {
  const cut = raw.search(/[?#]/);
  const s = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  if (!s || s.length > 200 || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export interface HeatBatch { pageKey: string; device: DeviceClass; experimentId?: string; automation: boolean; events: HeatEvent[] }

const bad = (field: string, message: string): never => {
  throw new OpenwopError('validation_error', message, 400, { field });
};
const fraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export function parseHeatBatch(body: Record<string, unknown>): HeatBatch {
  const pageKey = typeof body.page === 'string' ? normalizePageKey(body.page) : null;
  if (!pageKey) return bad('page', 'Field `page` must be the page path or slug (≤ 200 characters, no query or fragment).');
  const device = body.device;
  if (typeof device !== 'string' || !(DEVICE_CLASSES as readonly string[]).includes(device)) {
    return bad('device', `Field \`device\` must be one of: ${DEVICE_CLASSES.join(', ')}.`);
  }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > HEAT_BATCH_MAX) {
    return bad('events', `Field \`events\` must be an array of 1–${HEAT_BATCH_MAX} heat events.`);
  }
  const events: HeatEvent[] = [];
  body.events.forEach((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (e.t === 'click') {
      // A stable element id when the click landed on one, else the 2% grid square.
      const sel = e.sel === undefined ? null : selectorCell(e.sel);
      if (e.sel !== undefined && !sel) bad(`events[${i}].sel`, 'Field `sel` must be an element id (a letter, then letters, digits, `-` or `_`; ≤ 64).');
      if (sel) { events.push({ t: 'click', cell: sel }); return; }
      if (!fraction(e.x) || !fraction(e.y)) bad(`events[${i}]`, 'A click needs `x` and `y` as fractions of the page (0–1), or an element id `sel`.');
      events.push({ t: 'click', cell: gridCell(e.x as number, e.y as number) });
    } else if (e.t === 'scroll') {
      if (!fraction(e.depth)) bad(`events[${i}].depth`, 'Field `depth` must be the deepest fraction of the page reached (0–1).');
      events.push({ t: 'scroll', depth: e.depth as number });
    } else if (e.t === 'attn') {
      const section = sectionKey(e.section);
      if (!section) bad(`events[${i}].section`, 'Field `section` must be a section id (a letter, then letters, digits, `-` or `_`; ≤ 64).');
      if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0) bad(`events[${i}].ms`, 'Field `ms` must be a non-negative number of milliseconds.');
      events.push({ t: 'attn', section: section as string, ms: e.ms as number });
    } else {
      bad(`events[${i}].t`, 'Field `t` must be one of: click, scroll, attn.');
    }
  });
  const exp = body.experiment;
  const experimentId = exp && typeof exp === 'object' && typeof (exp as Record<string, unknown>).id === 'string'
    ? ((exp as Record<string, unknown>).id as string).slice(0, 128) || undefined
    : undefined;
  return { pageKey, device: device as DeviceClass, ...(experimentId ? { experimentId } : {}), automation: body.automation === true, events };
}
