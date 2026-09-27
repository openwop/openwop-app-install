/**
 * The declarative shortcut registry (ADR 0333 Phase 2): combo parsing/matching,
 * collision + reserved-combo policy, dispatch, and cheatsheet labels.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { comboLabel, dispatchShortcut, eventMatches, mergeShortcuts, parseCombo, type ShortcutDef } from '../shortcuts.js';

const kbd = (init: Partial<KeyboardEvent>): KeyboardEvent => new KeyboardEvent('keydown', { cancelable: true, ...init });
const def = (combo: string, run: () => void = () => undefined): ShortcutDef => ({ combo, labelKey: 'x', group: 'general', run });

afterEach(() => vi.restoreAllMocks());

describe('parseCombo + eventMatches', () => {
  it('matches mod+z on both meta and ctrl', () => {
    const c = parseCombo('mod+z');
    expect(eventMatches(kbd({ key: 'z', metaKey: true }), c)).toBe(true);
    expect(eventMatches(kbd({ key: 'z', ctrlKey: true }), c)).toBe(true);
    expect(eventMatches(kbd({ key: 'z' }), c)).toBe(false);
  });
  it('distinguishes shift and alt', () => {
    expect(eventMatches(kbd({ key: 'z', metaKey: true, shiftKey: true }), parseCombo('mod+shift+z'))).toBe(true);
    expect(eventMatches(kbd({ key: 'z', metaKey: true, shiftKey: true }), parseCombo('mod+z'))).toBe(false);
    expect(eventMatches(kbd({ key: ']', metaKey: true, altKey: true }), parseCombo('alt+mod+]'))).toBe(true);
    expect(eventMatches(kbd({ key: ']', metaKey: true }), parseCombo('alt+mod+]'))).toBe(false);
  });
  it("'?' matches regardless of the shift flag (the key IS the character)", () => {
    expect(eventMatches(kbd({ key: '?', shiftKey: true }), parseCombo('?'))).toBe(true);
  });
  it('escape matches without modifiers', () => {
    expect(eventMatches(kbd({ key: 'Escape' }), parseCombo('escape'))).toBe(true);
    expect(eventMatches(kbd({ key: 'Escape', metaKey: true }), parseCombo('escape'))).toBe(false);
  });
});

describe('mergeShortcuts', () => {
  it('drops extras that collide with defaults, keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const merged = mergeShortcuts([def('mod+z')], [def('mod+z'), def('mod+e')]);
    expect(merged.map((s) => s.combo)).toEqual(['mod+z', 'mod+e']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('reserves mod+k for the global command palette', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const merged = mergeShortcuts([], [def('mod+k')]);
    expect(merged).toHaveLength(0);
  });
});

describe('dispatchShortcut', () => {
  it('runs the first enabled match and preventDefaults', () => {
    const ran: string[] = [];
    const e = kbd({ key: 'z', metaKey: true });
    const handled = dispatchShortcut(e, [
      { ...def('mod+z', () => ran.push('undo')), enabled: () => true },
      def('mod+y', () => ran.push('redo')),
    ]);
    expect(handled).toBe(true);
    expect(ran).toEqual(['undo']);
    expect(e.defaultPrevented).toBe(true);
  });
  it('skips disabled entries and reports unhandled', () => {
    const e = kbd({ key: 'z', metaKey: true });
    const handled = dispatchShortcut(e, [{ ...def('mod+z'), enabled: () => false }]);
    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('comboLabel', () => {
  it('renders mac and non-mac forms', () => {
    expect(comboLabel('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(comboLabel('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(comboLabel('escape', false)).toBe('Esc');
  });
});

describe('shifted-digit combos (§7.3 zoom keys)', () => {
  it("matches 'shift+1' on e.code so it is layout-independent", () => {
    const e = new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true });
    expect(eventMatches(e, parseCombo('shift+1'))).toBe(true);
  });
  it('does not match without shift or on another digit', () => {
    expect(eventMatches(new KeyboardEvent('keydown', { key: '1', code: 'Digit1' }), parseCombo('shift+1'))).toBe(false);
    expect(eventMatches(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true }), parseCombo('shift+1'))).toBe(false);
  });
});

describe('AltGr layouts (grade-pass CVP-1)', () => {
  it("masks AltGraph out of mod/alt so produced characters ('[') match plain combos", () => {
    // A DE-layout AltGr+8 arrives as ctrl+alt with key '[' + AltGraph state.
    const e = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    expect(eventMatches(e, parseCombo('['))).toBe(true);
    // A REAL ctrl+alt chord (no AltGraph) still does not match plain '['.
    const chord = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, altKey: true });
    expect(eventMatches(chord, parseCombo('['))).toBe(false);
  });
});
