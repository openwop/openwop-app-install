/**
 * Style memory (ADR 0333 Phase 2) — last-used style per typeId:collection:kind,
 * filtered to the collection's styleKeys, session-ephemeral.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearStyleMemory, recallStyle, rememberStyle } from '../styleMemory.js';

const KEYS = ['fill', 'stroke', 'strokeWidth'];

beforeEach(() => clearStyleMemory());

describe('styleMemory', () => {
  it('remembers only the declared style keys, skipping empties', () => {
    rememberStyle('canvas.drawing', 'shapes', 'rect', { fill: 'red', x: 10, stroke: '', strokeWidth: 2 }, KEYS);
    expect(recallStyle('canvas.drawing', 'shapes', 'rect')).toEqual({ fill: 'red', strokeWidth: 2 });
  });
  it('merges partial updates over the remembered style', () => {
    rememberStyle('t', 'c', 'rect', { fill: 'red' }, KEYS);
    rememberStyle('t', 'c', 'rect', { stroke: 'blue' }, KEYS);
    expect(recallStyle('t', 'c', 'rect')).toEqual({ fill: 'red', stroke: 'blue' });
  });
  it('is keyed per kind and per type', () => {
    rememberStyle('t', 'c', 'rect', { fill: 'red' }, KEYS);
    expect(recallStyle('t', 'c', 'circle')).toEqual({});
    expect(recallStyle('other', 'c', 'rect')).toEqual({});
  });
  it('returns a copy (callers cannot mutate the store)', () => {
    rememberStyle('t', 'c', 'rect', { fill: 'red' }, KEYS);
    const got = recallStyle('t', 'c', 'rect');
    got.fill = 'green';
    expect(recallStyle('t', 'c', 'rect')).toEqual({ fill: 'red' });
  });
});
