/**
 * Builder canvas verb combos — keyboard SCOPE (HV-BLD-R2-2 / HV-BLD-R2-3).
 *
 * The registry's keydown owner is window-level, so ⌘A and Alt+Arrow are live
 * everywhere on the page unless something gates them. Two failure modes, both
 * of which have shipped in this repo's sibling surfaces (the kanban verb keys):
 *
 *   1. ⌘A while typing hijacks text select-all and selects canvas nodes.
 *   2. Alt+←/→ while focus is in a rail eats browser back/forward, because a
 *      shortcut that runs also calls preventDefault().
 *
 * These are checked here rather than only on the live app because they are
 * INVARIANTS, not observations: the defect returns silently the next time an
 * entry is added to the registry without the gate. A browser walk proves the
 * behaviour on the day it ran; this proves it on every commit.
 *
 * TWO pins, because one alone would over-claim:
 *
 *   1. BEHAVIOUR — drives the REAL path (`useSurfaceChrome`'s window listener,
 *      the real `dispatchShortcut`, the real `canvasOrNowhereFocused`) and
 *      asserts `defaultPrevented` directly, which IS the R2-3 requirement. A
 *      synthetic dispatch is the right vehicle precisely because this owner is
 *      a plain `window` listener, not a React handler. But it wires its own
 *      registry, so it CANNOT see a `BuilderShell` entry that forgot the gate.
 *   2. WIRING — asserts against `BuilderShell.tsx` itself that every canvas
 *      verb still carries the gate. Without this, stripping
 *      `canvasOrNowhereFocused()` from all three real `enabled` predicates
 *      leaves the whole suite green (measured, not assumed — a code review
 *      caught exactly that and this block is the answer to it).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useSurfaceChrome, type SurfaceChromeOptions } from '../../canvas/useSurfaceChrome.js';
import { inTextContext, type ShortcutDef } from '../../canvas/shortcuts.js';
import { canvasOrNowhereFocused } from '../builderShellHelpers.js';

const OPTS: SurfaceChromeOptions = {
  commandSourceKey: 'builder-scope-test',
  commandIdPrefix: 'bst',
  commandsGroupLabel: 'Builder',
  typeT: (k) => k,
  canvasT: (k) => k,
};

/** The two gated entries, wired exactly as `BuilderShell` wires them. */
function Harness({ onRun }: { onRun: (combo: string) => void }): JSX.Element {
  const chrome = useSurfaceChrome(OPTS);
  const gated = (combo: string): ShortcutDef => ({
    combo,
    labelKey: combo,
    group: 'type',
    enabled: () => canvasOrNowhereFocused(),
    run: () => onRun(combo),
  });
  chrome.commitShortcuts([gated('mod+a'), gated('alt+arrowright')]);
  return (
    <div>
      <div className="react-flow">
        <div data-testid="node" tabIndex={-1} />
        <input data-testid="node-title" />
      </div>
      <aside>
        <button data-testid="rail-button" type="button">Add node</button>
        <textarea data-testid="rail-textarea" />
      </aside>
    </div>
  );
}

/** @returns `true` when the browser default SURVIVED (nothing prevented it). */
function press(el: Element | Window, key: string, mods: Record<string, boolean>): boolean {
  return fireEvent.keyDown(el as Element, { key, ...mods });
}

afterEach(cleanup);

describe('builder canvas combos are scoped to the canvas', () => {
  it('canvas focused: ⌘A and Alt+Arrow run, and DO claim the key', () => {
    const ran: string[] = [];
    const { getByTestId } = render(<Harness onRun={(c) => ran.push(c)} />);
    const node = getByTestId('node');
    node.focus();

    // Positive control — without this the negative cases below are vacuous.
    expect(press(node, 'a', { metaKey: true })).toBe(false);   // preventDefault fired
    expect(press(node, 'ArrowRight', { altKey: true })).toBe(false);
    expect(ran).toEqual(['mod+a', 'alt+arrowright']);
  });

  it('HV-BLD-R2-3 — focus in a rail BUTTON: Alt+Arrow is left to the browser', () => {
    const ran: string[] = [];
    const { getByTestId } = render(<Harness onRun={(c) => ran.push(c)} />);
    const button = getByTestId('rail-button');
    button.focus();

    // A button is NOT a text context, so the chassis `inTextContext` guard
    // passes it straight through — `canvasOrNowhereFocused` is the only thing
    // standing between a rail button and browser back/forward. (Asserted on a
    // real dispatched event: a constructed `new KeyboardEvent` has a null
    // target and would return false no matter what, proving nothing.)
    // (`toBeFalsy`, not `toBe(false)`: `inTextContext` ends in `||
    // el.isContentEditable`, which jsdom leaves undefined on a button. The call
    // site truthy-checks it, so this is a jsdom artefact, not a defect — but
    // asserting `false` here would fail for a reason that has nothing to do
    // with scope.)
    let sawTextContext: unknown;
    const spy = (e: Event): void => { sawTextContext = inTextContext(e as KeyboardEvent); };
    window.addEventListener('keydown', spy);
    expect(press(button, 'ArrowRight', { altKey: true })).toBe(true); // default SURVIVED
    window.removeEventListener('keydown', spy);
    expect(sawTextContext).toBeFalsy();
    expect(press(button, 'a', { metaKey: true })).toBe(true);
    expect(ran).toEqual([]);
  });

  it('HV-BLD-R2-2 — ⌘A in a rail textarea selects text, never nodes', () => {
    const ran: string[] = [];
    const { getByTestId } = render(<Harness onRun={(c) => ran.push(c)} />);
    const textarea = getByTestId('rail-textarea');
    textarea.focus();
    expect(press(textarea, 'a', { metaKey: true })).toBe(true);
    expect(ran).toEqual([]);
  });

  it('HV-BLD-R2-2 — ⌘A in the node-title input is held by the CHASSIS guard, not this one', () => {
    const ran: string[] = [];
    const { getByTestId } = render(<Harness onRun={(c) => ran.push(c)} />);
    const title = getByTestId('node-title');
    title.focus();

    // Documenting the layering honestly: this input lives INSIDE `.react-flow`,
    // so the canvas gate says "yes, canvas" and would NOT have saved it. What
    // saves it is `inTextContext` returning before dispatch. If anyone ever
    // relaxes that chassis guard, this input is the first thing to break.
    expect(canvasOrNowhereFocused()).toBe(true);
    expect(press(title, 'a', { metaKey: true })).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe('every canvas verb in BuilderShell actually carries the gate', () => {
  /**
   * The behaviour block above wires its own registry, so it is blind to a real
   * entry that forgot the gate — which is the regression most likely to
   * happen, since adding a shortcut means copying a neighbouring line. This
   * reads the shell source and holds each canvas-verb entry to it.
   */
  const source = readFileSync(resolve(process.cwd(), 'src/builder/BuilderShell.tsx'), 'utf8');

  /**
   * Each entry = its `combo:` through to its `run:`. Bounding at `run:` matters
   * twice: the gate belongs in `enabled`, which always precedes `run`, so a
   * mention inside a run body must not count as gated — and without the bound
   * the LAST entry's chunk would run to end-of-file and pass on any later
   * mention of the helper, including one in a comment.
   */
  const entries = Array.from(
    source.matchAll(/combo:\s*(`[^`]+`|'[^']+')([\s\S]*?)run:/g),
    (m) => ({ combo: m[1]!, beforeRun: m[2]! }),
  );

  /**
   * INVERTED on purpose. An allowlist of "these three are canvas verbs" fails
   * open: a NEW verb nobody added to the list is silently exempt, which is the
   * regression this block exists to catch. So the default is "must be gated",
   * and each exemption is named. Adding a shortcut to the shell now forces a
   * deliberate, reviewable choice here.
   *
   * Exempt = combos that are legitimately live while typing in a rail, because
   * they either target the focused text (⌘Z/⌘C/⌘V) or have their own guard
   * (`/` checks the palette input exists).
   */
  const UNGATED_BY_DESIGN = new Set([
    "'mod+z'", "'mod+shift+z'", "'mod+y'", "'mod+c'", "'mod+v'", "'mod+d'", "'/'",
  ]);

  it('finds the entries at all (a broken regex would pass every assertion below)', () => {
    // 10 → 11 (R3): the flood-select combo template (mod+alt+shift+arrow) — gated.
    expect(entries.length).toBe(11);
    // …and the exempt list must not have drifted into naming combos that are gone.
    const combos = new Set(entries.map((e) => e.combo));
    const staleExemptions = [...UNGATED_BY_DESIGN].filter((c) => !combos.has(c));
    expect(staleExemptions).toEqual([]);
  });

  it('gates every non-exempt entry on canvasOrNowhereFocused()', () => {
    const ungated = entries
      .filter((e) => !UNGATED_BY_DESIGN.has(e.combo))
      .filter((e) => !e.beforeRun.includes('canvasOrNowhereFocused()'))
      .map((e) => e.combo);
    expect(ungated).toEqual([]);
  });
});
