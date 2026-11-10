/** Host-local film data and deterministic evaluation shared by server and browser.
 * No HTML, provider calls, DOM, clocks or application-specific state belong here.
 */
export interface FilmPose { x: number; y: number; opacity: number; scale: number }
export interface FilmElement {
  id: string;
  kind: 'text' | 'image' | 'shape';
  text?: string;
  assetId?: string;
  alt?: string;
  width: number;
  height: number;
  size?: 'title' | 'body' | 'caption';
  tone?: 'default' | 'accent';
  initial: FilmPose;
}
export interface FilmCue {
  id: string;
  label: string;
  durationMs: number;
  changes: { elementId: string; to: Partial<FilmPose> }[];
}
export interface FilmScene { id: string; title: string; notes?: string; elements: FilmElement[]; cues: FilmCue[] }
export interface FilmSpec { version: 1; title: string; scenes: FilmScene[] }
export interface FilmStep { sceneId: string; cueId: string | null; label: string; durationMs: number }
export interface FilmIssue { path: string; message: string }
export const FILM_LIMITS = { scenes: 100, elements: 40, cues: 40, totalCues: 1000, totalAssets: 100, text: 4000, notes: 8000, durationMs: 10000 } as const;
const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' };
const text = (maxLength: number) => ({ type: 'string', maxLength });
const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, properties, required });
const poseFields = { x: number(-1, 2), y: number(-1, 2), opacity: number(0, 1), scale: number(0.1, 4) };
export const FILM_SCHEMA = object({
  version: { const: 1 }, title: text(240), scenes: { type: 'array', minItems: 1, maxItems: FILM_LIMITS.scenes, items: object({
    id: idSchema, title: text(240), notes: text(FILM_LIMITS.notes),
    elements: { type: 'array', minItems: 1, maxItems: FILM_LIMITS.elements, items: object({
      id: idSchema, kind: { enum: ['text', 'image', 'shape'] }, text: text(FILM_LIMITS.text), assetId: text(200), alt: text(1000),
      width: number(0.01, 1), height: number(0.01, 1), size: { enum: ['title', 'body', 'caption'] }, tone: { enum: ['default', 'accent'] },
      initial: object(poseFields, ['x', 'y', 'opacity', 'scale']),
    }, ['id', 'kind', 'width', 'height', 'initial']) },
    cues: { type: 'array', maxItems: FILM_LIMITS.cues, items: object({
      id: idSchema, label: text(240), durationMs: { type: 'integer', minimum: 0, maximum: FILM_LIMITS.durationMs },
      changes: { type: 'array', minItems: 1, maxItems: FILM_LIMITS.elements, items: object({ elementId: idSchema, to: { ...object(poseFields, []), minProperties: 1 } }, ['elementId', 'to']) },
    }, ['id', 'label', 'durationMs', 'changes']) },
  }, ['id', 'title', 'elements', 'cues']) },
}, ['version', 'title', 'scenes']);

/** Bounded interpreter of this schema's small closed vocabulary. Keeps browser
 * and server validation identical without bundling a schema compiler in playback.
 */
function check(schema: Record<string, unknown>, value: unknown, path: string, errors: FilmIssue[]): void {
  if (errors.length >= 30) return;
  const bad = (message: string) => { errors.push({ path, message }); };
  if ('const' in schema && value !== schema.const) { bad('Unsupported film version.'); return; }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) { bad('Unsupported value.'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { bad('Expected an object.'); return; }
    const fields = schema.properties as Record<string, Record<string, unknown>>;
    const raw = value as Record<string, unknown>;
    for (const required of schema.required as string[]) if (!(required in raw)) errors.push({ path: `${path}.${required}`, message: 'Required field.' });
    const keys = Object.keys(raw);
    if (keys.length > Object.keys(fields).length) { bad('Unknown fields are not permitted.'); return; }
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) bad('An animation must change a property.');
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) { bad(`Unknown field: ${key}.`); continue; }
      check(fields[key]!, raw[key], `${path}.${key}`, errors);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { bad('Expected a list.'); return; }
    if (value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems)) { bad('List exceeds film limits.'); return; }
    value.forEach((item, i) => check(schema.items as Record<string, unknown>, item, `${path}[${i}]`, errors));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > Number(schema.maxLength ?? 64)) { bad('Invalid or overlong text.'); return; }
    if (schema.pattern && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) bad('Use a stable alphanumeric ID.');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < Number(schema.minimum) || value > Number(schema.maximum) || (schema.type === 'integer' && !Number.isInteger(value))) bad('Number is outside film limits.');
  }
}
export function validateFilm(value: unknown): FilmIssue[] {
  const errors: FilmIssue[] = [];
  check(FILM_SCHEMA, value, 'film', errors);
  if (errors.length) return errors;
  const film = value as FilmSpec;
  const scenes = new Set<string>(), cues = new Set<string>();
  const assets = new Set<string>();
  let count = 0;
  for (const scene of film.scenes) {
    if (scenes.has(scene.id)) errors.push({ path: scene.id, message: 'Duplicate scene ID.' });
    scenes.add(scene.id);
    const elements = new Set<string>();
    for (const e of scene.elements) {
      if (elements.has(e.id)) errors.push({ path: e.id, message: 'Duplicate element ID.' });
      elements.add(e.id);
      if (e.kind === 'text' && typeof e.text !== 'string') errors.push({ path: e.id, message: 'Text elements require text.' });
      if (e.kind === 'image' && (!e.assetId || typeof e.alt !== 'string')) errors.push({ path: e.id, message: 'Images require a Media asset ID and alternative text.' });
      if (e.kind === 'image' && e.assetId) assets.add(e.assetId);
    }
    for (const cue of scene.cues) {
      count++;
      if (cues.has(cue.id)) errors.push({ path: cue.id, message: 'Duplicate cue ID.' });
      cues.add(cue.id);
      const targets = new Set<string>();
      for (const change of cue.changes) {
        if (!elements.has(change.elementId) || targets.has(change.elementId)) errors.push({ path: cue.id, message: 'Cue targets must name distinct elements in this scene.' });
        targets.add(change.elementId);
      }
    }
  }
  if (count > FILM_LIMITS.totalCues) errors.push({ path: 'film.scenes', message: 'Too many animation cues.' });
  if (assets.size > FILM_LIMITS.totalAssets) errors.push({ path: 'film.scenes', message: 'Too many image assets.' });
  return errors;
}
export function audienceFilm(film: FilmSpec): FilmSpec {
  return { version: film.version, title: film.title, scenes: film.scenes.map(({ notes: _notes, ...scene }) => ({ ...scene, elements: scene.elements.map(e => ({ ...e, initial: { ...e.initial } })), cues: scene.cues.map(c => ({ ...c, changes: c.changes.map(change => ({ elementId: change.elementId, to: { ...change.to } })) })) })) };
}
export function filmSteps(film: FilmSpec): FilmStep[] {
  return film.scenes.flatMap(scene => [{ sceneId: scene.id, cueId: null, label: scene.title, durationMs: 0 }, ...scene.cues.map(c => ({ sceneId: scene.id, cueId: c.id, label: c.label, durationMs: c.durationMs }))]);
}
export function evaluateFilm(film: FilmSpec, index: number, progress = 1): { scene: FilmScene; poses: Record<string, FilmPose> } {
  const steps = filmSteps(film);
  const step = steps[Math.max(0, Math.min(steps.length - 1, Math.floor(index)))];
  const scene = film.scenes.find(s => s.id === step?.sceneId) ?? film.scenes[0]!;
  const poses: Record<string, FilmPose> = Object.create(null) as Record<string, FilmPose>;
  for (const e of scene.elements) poses[e.id] = { ...e.initial };
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1;
  if (step?.cueId) for (const cue of scene.cues) {
    const active = cue.id === step.cueId;
    for (const change of cue.changes) {
      const pose = poses[change.elementId];
      if (!pose) continue;
      for (const key of ['x', 'y', 'opacity', 'scale'] as const) {
        const to = change.to[key];
        if (to !== undefined) pose[key] = active ? pose[key] + (to - pose[key]) * p : to;
      }
    }
    if (active) break;
  }
  return { scene, poses };
}
export function blankFilm(title: string): FilmSpec {
  return { version: 1, title, scenes: [{ id: 'opening', title, elements: [
    { id: 'heading', kind: 'text', text: title, size: 'title', width: 0.84, height: 0.3, initial: { x: 0.08, y: 0.18, opacity: 1, scale: 1 } },
    { id: 'message', kind: 'text', text: 'One visual story. Your pace.', size: 'body', width: 0.84, height: 0.25, initial: { x: 0.08, y: 0.6, opacity: 0, scale: 1 } },
  ], cues: [{ id: 'reveal-message', label: 'Reveal message', durationMs: 500, changes: [{ elementId: 'message', to: { opacity: 1, y: 0.55 } }] }] }] };
}
