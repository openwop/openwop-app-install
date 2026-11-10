import { filmSteps, type FilmSpec } from '../../../../../contracts/films.js';

export interface FilmPosition { step: number; progress: number; blank: boolean }
export const firstFilmPosition = (): FilmPosition => ({ step: 0, progress: 1, blank: false });
/** Next during a transition completes that cue; a second advance starts the next. */
export function moveFilm(film: FilmSpec, position: FilmPosition, direction: 'next' | 'back', reducedMotion = false): FilmPosition {
  if (direction === 'next' && position.progress < 1) return { ...position, progress: 1 };
  const steps = filmSteps(film);
  const step = Math.max(0, Math.min(steps.length - 1, position.step + (direction === 'next' ? 1 : -1)));
  return { ...position, step, progress: direction === 'next' && step !== position.step && steps[step]!.durationMs > 0 && !reducedMotion ? 0 : 1 };
}
export function validPosition(film: FilmSpec, value: unknown): value is FilmPosition {
  if (!value || typeof value !== 'object') return false;
  const p = value as FilmPosition;
  return Number.isInteger(p.step) && p.step >= 0 && p.step < filmSteps(film).length && Number.isFinite(p.progress) && p.progress >= 0 && p.progress <= 1 && typeof p.blank === 'boolean';
}
