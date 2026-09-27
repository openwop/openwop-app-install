/**
 * Canvas framework — the frames-trait factory (ADR 0310, extracted from the
 * app-builder's screenOps.ts / ADR 0305 Phase B). A canvas type whose document
 * holds an ordered list of frames (screens/slides/pages) instantiates
 * `frameOps()` with its trait config; the returned helpers mutate an
 * ALREADY-CLONED doc in place (the editor page clones before calling). The
 * invariants (single home frame, per-type delete cascade, last-frame guard)
 * are the bug-prone part, so they live here, unit-tested, not in React.
 */

/** The minimal frame shape; per-type fields (route, layout, …) ride along. */
export interface FrameBase {
  id: string;
  name: string;
}

export interface FrameOpsConfig<Doc extends object, F extends FrameBase> {
  /** The doc key holding the frame array ('screens' | 'slides' | 'pages' | …). */
  key: string;
  max: number;
  /** The single-home flag field (e.g. 'isInitial'); omit when the type has none. */
  homeFlag?: string;
  /** id fallback when a frame name slugs to nothing (app-builder: 'screen'). */
  slugFallback?: string;
  /** Build a new empty frame of the type's shape (route, layout, …). */
  makeFrame?: (id: string, name: string) => F;
  /** Re-stamp per-type derived fields on a duplicated/instantiated frame
   *  after its id/name were remapped (e.g. app-builder's `route`). */
  restamp?: (frame: F, id: string) => void;
  /** Per-type cleanup when a frame is deleted (e.g. app-builder drops
   *  connectors referencing the screen id). Mutates the cloned doc. */
  cascade?: (doc: Doc, removedFrameId: string) => void;
}

export interface FrameTemplate {
  name: string;
  /** Deep-cloned into the new frame (per-type keys, e.g. `{ components }`). */
  content: Record<string, unknown>;
}

export interface FrameOps<Doc extends object, F extends FrameBase> {
  frames(doc: Doc): F[];
  nextFrameId(frames: F[], name: string): string;
  addFrame(doc: Doc, name: string): number;
  renameFrame(doc: Doc, index: number, name: string): void;
  duplicateFrame(doc: Doc, index: number): number;
  deleteFrame(doc: Doc, index: number): boolean;
  reorderFrame(doc: Doc, index: number, toIndex: number): void;
  setHomeFrame(doc: Doc, index: number): void;
  addFrameFromTemplate(doc: Doc, template: FrameTemplate): number;
}

const slugify = (name: string, fallback: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;

/** Dynamic-key access confined to this one helper — concrete doc/frame
 *  interfaces stay index-signature-free at every call site. */
const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

export function frameOps<Doc extends object, F extends FrameBase = FrameBase>(
  config: FrameOpsConfig<Doc, F>,
): FrameOps<Doc, F> {
  const { key, max, homeFlag } = config;
  const slugFallback = config.slugFallback ?? 'frame';
  const makeFrame = config.makeFrame ?? ((id: string, name: string) => ({ id, name }) as F);

  const frames = (doc: Doc): F[] => {
    if (!dict(doc)[key]) dict(doc)[key] = [];
    return dict(doc)[key] as F[];
  };
  const setHomeFlagOn = (f: F): void => {
    if (homeFlag) dict(f)[homeFlag] = true;
  };
  const clearHomeFlag = (f: F): void => {
    if (homeFlag) delete dict(f)[homeFlag];
  };
  const isHome = (f: F): boolean => (homeFlag ? dict(f)[homeFlag] === true : false);

  /** A deterministic unique frame id derived from the name — no clock/random
   *  (derivable from existing state; replays and re-renders agree). */
  function nextFrameId(list: F[], name: string): string {
    const base = slugify(name, slugFallback);
    if (!list.some((s) => s.id === base)) return base;
    let n = 2;
    while (list.some((s) => s.id === `${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /** Append a new empty frame. Returns its index, or -1 at the `max` cap. */
  function addFrame(doc: Doc, name: string): number {
    const list = frames(doc);
    if (list.length >= max) return -1;
    const id = nextFrameId(list, name);
    const frame = makeFrame(id, name);
    if (list.length === 0) setHomeFlagOn(frame);
    list.push(frame);
    return list.length - 1;
  }

  /** Rename a frame (display name only — the id, and anything keyed on it, stay stable). */
  function renameFrame(doc: Doc, index: number, name: string): void {
    const s = frames(doc)[index];
    if (s && name.trim()) s.name = name.trim();
  }

  /** Deep-clone the frame at `index` and insert it right after. The copy is
   *  never the home frame (single-home invariant). Returns the copy's index,
   *  or -1 on invalid index / cap. */
  function duplicateFrame(doc: Doc, index: number): number {
    const list = frames(doc);
    const src = list[index];
    if (!src || list.length >= max) return -1;
    const copy = JSON.parse(JSON.stringify(src)) as F;
    clearHomeFlag(copy);
    copy.id = nextFrameId(list, `${src.name} copy`);
    copy.name = `${src.name} copy`;
    config.restamp?.(copy, copy.id);
    list.splice(index + 1, 0, copy);
    return index + 1;
  }

  /** Delete the frame at `index`. Refuses to delete the last frame (a canvas
   *  document always has one). Runs the per-type cascade, and reassigns the
   *  home flag to the first remaining frame when the home frame was deleted.
   *  Returns true when deleted. */
  function deleteFrame(doc: Doc, index: number): boolean {
    const list = frames(doc);
    if (list.length <= 1) return false;
    const victim = list[index];
    if (!victim) return false;
    list.splice(index, 1);
    config.cascade?.(doc, victim.id);
    if (isHome(victim) && list[0]) setHomeFlagOn(list[0]);
    return true;
  }

  /** Move the frame at `index` to `toIndex` (clamped). */
  function reorderFrame(doc: Doc, index: number, toIndex: number): void {
    const list = frames(doc);
    const s = list[index];
    if (!s) return;
    list.splice(index, 1);
    const i = Math.max(0, Math.min(toIndex, list.length));
    list.splice(i, 0, s);
  }

  /** Make the frame at `index` the single home frame (no-op without a homeFlag). */
  function setHomeFrame(doc: Doc, index: number): void {
    if (!homeFlag) return;
    const list = frames(doc);
    if (!list[index]) return;
    list.forEach((s, i) => {
      if (i === index) setHomeFlagOn(s);
      else clearHomeFlag(s);
    });
  }

  /** Instantiate a frame TEMPLATE (ADR 0305 Phase F) as a new frame: deep-clone
   *  the template content, remap the id via nextFrameId (collision-safe when the
   *  same template is added twice). Returns the new index, or -1 at the cap. */
  function addFrameFromTemplate(doc: Doc, template: FrameTemplate): number {
    const list = frames(doc);
    if (list.length >= max) return -1;
    const id = nextFrameId(list, template.name);
    const frame = makeFrame(id, template.name);
    const content = JSON.parse(JSON.stringify(template.content)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(content)) dict(frame)[k] = v;
    config.restamp?.(frame, id);
    if (list.length === 0) setHomeFlagOn(frame);
    list.push(frame);
    return list.length - 1;
  }

  return {
    frames,
    nextFrameId,
    addFrame,
    renameFrame,
    duplicateFrame,
    deleteFrame,
    reorderFrame,
    setHomeFrame,
    addFrameFromTemplate,
  };
}
