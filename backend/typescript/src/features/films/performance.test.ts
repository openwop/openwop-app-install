import { describe, expect, it } from 'vitest';
import { blankFilm, evaluateFilm } from '../../../../../contracts/films.js';
import { compileFilmPerformance, filmTimingHash, performanceEvent, validateFilmPerformance, PERFORMANCE_LIMITS, type FilmPerformance } from '../../../../../contracts/filmPerformance.js';
describe('silent performance timing', () => {
  it('reconstructs motion, rewind, blanking and exact boundaries without replaying effects', async () => {
    const film = blankFilm('Rehearsal'); const hash = await filmTimingHash(film);
    const take: FilmPerformance = { version: 1, filmHash: hash, durationMs: 5000, events: [
      performanceEvent(film, { step: 0, progress: 1, blank: false }, 0),
      performanceEvent(film, { step: 1, progress: 0, blank: false }, 2000),
      performanceEvent(film, { step: 1, progress: .4, blank: true }, 2200),
      performanceEvent(film, { step: 0, progress: 1, blank: false }, 3000),
      performanceEvent(film, { step: 1, progress: 1, blank: false }, 4000),
    ] };
    expect(validateFilmPerformance(film, take, hash)).toEqual([]);
    const before = JSON.stringify({ film, take }); const at = compileFilmPerformance(film, take);
    expect(at(1999)).toEqual({ step: 0, progress: 1, blank: false });
    expect(at(2000)).toEqual({ step: 1, progress: 0, blank: false });
    expect(at(2250)).toEqual({ step: 1, progress: .5, blank: true });
    expect(evaluateFilm(film, at(2250).step, at(2250).progress).poses.message!.opacity).toBe(.5);
    expect(at(2250, true)).toEqual({ step: 1, progress: 1, blank: true });
    expect(at(3000)).toEqual({ step: 0, progress: 1, blank: false });
    expect(at(100000)).toEqual(at(5000)); expect(at(-1)).toEqual(at(0));
    expect(at(2250)).toEqual(at(2250)); expect(JSON.stringify({ film, take })).toBe(before);
  });
  it('has no note hash oracle and refuses changed visuals, unordered events, wrong cues and oversize takes', async () => {
    const film = blankFilm('Story'); const hash = await filmTimingHash(film);
    film.scenes[0]!.notes = 'PRIVATE-NOTES'; expect(await filmTimingHash(film)).toBe(hash);
    const take: FilmPerformance = { version: 1, filmHash: hash, durationMs: 1000, events: [performanceEvent(film, { step: 0, progress: 1, blank: false }, 0)] };
    expect(validateFilmPerformance(film, take, hash)).toEqual([]);
    for (const mutate of [
      (t: FilmPerformance) => { t.durationMs = PERFORMANCE_LIMITS.durationMs + 1; },
      (t: FilmPerformance) => { t.events[0]!.atMs = 1; },
      (t: FilmPerformance) => { t.events[0]!.cueId = 'foreign'; },
      (t: FilmPerformance) => { t.events[0]!.progress = NaN; },
      (t: FilmPerformance) => { t.events.push({ ...t.events[0]!, atMs: 10 }, { ...t.events[0]!, atMs: 9 }); },
      (t: FilmPerformance) => { t.events = Array.from({ length: PERFORMANCE_LIMITS.events + 1 }, () => ({ ...t.events[0]! })); },
    ]) { const altered = structuredClone(take); mutate(altered); expect(validateFilmPerformance(film, altered, hash).length).toBeGreaterThan(0); }
    film.scenes[0]!.elements[0]!.text = 'Different approved copy';
    expect(validateFilmPerformance(film, take, await filmTimingHash(film)).length).toBeGreaterThan(0);
  });
  it('preserves rapid same-time commands in order and hashes equivalent JSON key order identically', async () => {
    const film = blankFilm('Rapid'); const hash = await filmTimingHash(film);
    // Top-level insertion order is not part of visual identity.
    expect(await filmTimingHash({ scenes: film.scenes, title: film.title, version: 1 })).toBe(hash);
    const take: FilmPerformance = { version: 1, filmHash: hash, durationMs: 10, events: [performanceEvent(film, { step: 0, progress: 1, blank: false }, 0), performanceEvent(film, { step: 1, progress: 1, blank: false }, 0)] };
    expect(validateFilmPerformance(film, take, hash)).toEqual([]);
    expect(compileFilmPerformance(film, take)(0).step).toBe(1);
  });
});
