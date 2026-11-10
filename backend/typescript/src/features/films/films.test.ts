import { describe, expect, it } from 'vitest';
import { audienceFilm, blankFilm, evaluateFilm, validateFilm } from '../../../../../contracts/films.js';

describe('shared film contract', () => {
  it('reconstructs grouped cue state deterministically without mutating the film', () => {
    const film = blankFilm('A story');
    const before = JSON.stringify(film);
    expect(validateFilm(film)).toEqual([]);
    expect(evaluateFilm(film, 0).poses.message!.opacity).toBe(0);
    expect(evaluateFilm(film, 1, 0.5).poses.message).toMatchObject({ opacity: 0.5, y: 0.575 });
    expect(evaluateFilm(film, 1).poses.message).toMatchObject({ opacity: 1, y: 0.55 });
    expect(evaluateFilm(film, 0).poses.message!.opacity).toBe(0);
    expect(JSON.stringify(film)).toBe(before);
  });
  it('refuses executable fields, duplicate identities, bad references and unbounded timing', () => {
    for (const alter of [
      (f: ReturnType<typeof blankFilm>) => Object.assign(f.scenes[0]!.elements[0]!, { html: '<script>bad()</script>' }),
      (f: ReturnType<typeof blankFilm>) => { f.scenes[0]!.cues[0]!.changes[0]!.elementId = 'other-scene'; },
      (f: ReturnType<typeof blankFilm>) => { f.scenes[0]!.cues[0]!.durationMs = Infinity; },
      (f: ReturnType<typeof blankFilm>) => { f.scenes.push(structuredClone(f.scenes[0]!)); },
    ]) { const film = blankFilm('Story'); alter(film); expect(validateFilm(film).length).toBeGreaterThan(0); }
  });
  it('strips private notes structurally and does not share mutable visual state', () => {
    const film = blankFilm('Story'); film.scenes[0]!.notes = 'PRIVATE-CANARY';
    const publicFilm = audienceFilm(film);
    expect(JSON.stringify(publicFilm)).not.toContain('PRIVATE-CANARY');
    expect(Object.hasOwn(publicFilm.scenes[0]!, 'notes')).toBe(false);
    publicFilm.scenes[0]!.elements[0]!.initial.opacity = 0;
    expect(film.scenes[0]!.elements[0]!.initial.opacity).toBe(1);
  });
});
