import { describe, expect, it } from 'vitest';
import { blankFilm } from '../../../../../contracts/films.js';
import { firstFilmPosition, moveFilm, validPosition } from './playback.js';
describe('manual film control', () => {
  it('starts one cue, completes before advancing, holds, clamps and reconstructs on back', () => {
    const film = blankFilm('Story'); const initial = firstFilmPosition();
    const moving = moveFilm(film, initial, 'next');
    expect(moving).toEqual({ step: 1, progress: 0, blank: false });
    const completed = moveFilm(film, moving, 'next');
    expect(completed).toEqual({ step: 1, progress: 1, blank: false });
    expect(moveFilm(film, completed, 'next')).toEqual(completed);
    expect(moveFilm(film, completed, 'back')).toEqual(initial);
    expect(moveFilm(film, initial, 'back')).toEqual(initial);
  });
  it('supports reduced motion and rejects stale or out-of-bounds audience positions', () => {
    const film = blankFilm('Story');
    expect(moveFilm(film, firstFilmPosition(), 'next', true).progress).toBe(1);
    expect(validPosition(film, { step: 5, progress: 1, blank: false })).toBe(false);
    expect(validPosition(film, { step: 0, progress: NaN, blank: false })).toBe(false);
    expect(validPosition(film, firstFilmPosition())).toBe(true);
  });
});
