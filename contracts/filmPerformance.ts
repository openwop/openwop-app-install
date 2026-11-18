/** Host-local, silent cue performances. Film source, narration and notes are never copied. */
import { audienceFilm, filmSteps, validateFilm, type FilmIssue, type FilmSpec } from './films.js';
export interface PerformancePosition { step: number; progress: number; blank: boolean }
export interface FilmPerformanceEvent {
  atMs: number; sceneId: string; cueId: string | null; progress: number; animate: boolean; blank: boolean;
}
export interface FilmPerformance { version: 1; filmHash: string; durationMs: number; events: FilmPerformanceEvent[] }
export const PERFORMANCE_LIMITS = { durationMs: 3_600_000, events: 4096 } as const;
const keysOnly = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every(k => keys.includes(k)) && keys.every(k => k in x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical) : record(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
/** Hash only the audience-safe visual model; private notes cannot become a hash oracle. */
export async function filmTimingHash(film: FilmSpec): Promise<string> {
  if (validateFilm(film).length) throw new Error('Invalid film');
  const data = new TextEncoder().encode(JSON.stringify(canonical(audienceFilm(film))));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateFilmPerformance(film: FilmSpec, value: unknown, expectedHash: string): FilmIssue[] {
  const bad = (message: string): FilmIssue[] => [{ path: 'performance', message }];
  if (validateFilm(film).length) return bad('Invalid source film.');
  if (!record(value) || !keysOnly(value, ['version', 'filmHash', 'durationMs', 'events']) || value.version !== 1 ||
    typeof value.filmHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.filmHash) || value.filmHash !== expectedHash) return bad('The timing take belongs to a different film.');
  if (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > PERFORMANCE_LIMITS.durationMs ||
    !Array.isArray(value.events) || value.events.length < 1 || value.events.length > PERFORMANCE_LIMITS.events) return bad('Timing take exceeds its duration or event limits.');
  const steps = filmSteps(film); let previous = -1;
  for (const event of value.events) {
    if (!record(event) || !keysOnly(event, ['atMs', 'sceneId', 'cueId', 'progress', 'animate', 'blank']) || typeof event.atMs !== 'number' || !Number.isSafeInteger(event.atMs) ||
      event.atMs < previous || event.atMs > value.durationMs || typeof event.progress !== 'number' || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1 ||
      typeof event.animate !== 'boolean' || typeof event.blank !== 'boolean') return bad('Invalid or unordered timing event.');
    const step = steps.find(s => s.sceneId === event.sceneId && s.cueId === event.cueId);
    if (!step || (event.animate && (!step.durationMs || event.progress >= 1))) return bad('Timing events must reference valid animation cues.');
    previous = event.atMs;
  }
  const first = value.events[0] as FilmPerformanceEvent;
  if (first.atMs !== 0 || first.sceneId !== steps[0]!.sceneId || first.cueId !== null || first.progress !== 1 || first.blank || first.animate) return bad('A rehearsal must begin at the first held cue.');
  return [];
}
export function performanceEvent(film: FilmSpec, position: PerformancePosition, atMs: number): FilmPerformanceEvent {
  const step = filmSteps(film)[position.step]!;
  return { atMs: Math.max(0, Math.round(atMs)), sceneId: step.sceneId, cueId: step.cueId, progress: position.progress, animate: position.progress < 1 && step.durationMs > 0, blank: position.blank };
}
/** Compile once. Seeking is reconstruction, never a replay of controller commands or effects. */
export function compileFilmPerformance(film: FilmSpec, take: FilmPerformance): (atMs: number, reducedMotion?: boolean) => PerformancePosition {
  if (validateFilmPerformance(film, take, take.filmHash).length) throw new Error('Invalid film performance');
  const steps = filmSteps(film);
  const entries = take.events.map(event => ({ event, step: steps.findIndex(s => s.sceneId === event.sceneId && s.cueId === event.cueId) }));
  return (atMs, reducedMotion = false) => {
    const time = Math.max(0, Math.min(take.durationMs, Number.isFinite(atMs) ? atMs : 0));
    let low = 0, high = entries.length;
    while (low < high) { const mid = (low + high) >>> 1; if (entries[mid]!.event.atMs <= time) low = mid + 1; else high = mid; }
    const { event, step } = entries[Math.max(0, low - 1)]!;
    const progress = event.animate ? Math.min(1, event.progress + (time - event.atMs) / steps[step]!.durationMs) : event.progress;
    return { step, progress: reducedMotion && event.animate ? 1 : progress, blank: event.blank };
  };
}
