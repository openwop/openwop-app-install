/**
 * Declarative keyboard-shortcut registry for the canvas chassis (ADR 0333
 * Phase 2). ONE window-keydown owner per editor page: the chassis's defaults
 * (undo/redo, Esc, arrange, `?`) merge with the definition's extras; a
 * definition entry whose combo collides with a chassis default is DROPPED
 * with a dev warning (the chassis grammar is app-wide). ⌘K is reserved to
 * the global CommandPalette (ui/) and is never registrable here.
 *
 * Matching is deliberately simple — a combo is `[mod+][shift+][alt+]key`
 * where `mod` = ⌘ on mac / Ctrl elsewhere (either matches), `key` is
 * `KeyboardEvent.key` lowercased (`'?'` works because Shift produces the
 * character itself). Text contexts and IME composition never match (the
 * caller guards). Pure — the React wiring lives in the chassis.
 */

export interface ShortcutDef {
  /** e.g. 'mod+z', 'mod+shift+z', 'escape', '?', 'mod+]', 'alt+mod+]'. */
  combo: string;
  /** i18n key (canvas ns for chassis defaults; TYPE ns keys pass a `ns:` prefix
   *  handled by the overlay's t). */
  labelKey: string;
  /** Cheatsheet group: 'general' | 'arrange' | 'view' | 'type'. */
  group: 'general' | 'arrange' | 'view' | 'type';
  /** Skip matching when disabled (still listed, dimmed, in the cheatsheet). */
  enabled?: () => boolean;
  run: (e: KeyboardEvent) => void;
}

interface ParsedCombo { mod: boolean; shift: boolean; alt: boolean; key: string }

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key,
  };
}

/** Does the event match the combo? `?` and other shifted characters match on
 *  the produced character, so their `shift` flag is not enforced. Shifted
 *  DIGIT combos ('shift+1' — the §7.3 zoom keys) match on `e.code`
 *  (`Digit1`): the produced character is layout-dependent ('!' on US,
 *  '+' on Czech), so the physical digit key is the only stable identity. */
export function eventMatches(e: KeyboardEvent, c: ParsedCombo): boolean {
  // Grade-pass CVP-1 — AltGr (European layouts) reports ctrl+alt in browsers,
  // which made every produced character ('[', ']', '@'…) unmatchable: the
  // phantom modifiers failed the mod/alt equality. AltGraph is a CHARACTER
  // modifier, not a chord modifier — mask it out of both.
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  const mod = (e.metaKey || e.ctrlKey) && !altGraph;
  if (c.mod !== mod) return false;
  if (c.alt !== (e.altKey && !altGraph)) return false;
  if (c.shift && /^[0-9]$/.test(c.key)) {
    return e.shiftKey && e.code === `Digit${c.key}`;
  }
  const key = e.key.toLowerCase();
  if (key !== c.key) return false;
  // Shifted-character combos ('?') carry shift implicitly in the key itself.
  const shiftImplicit = ['?', '{', '}', '<', '>'].includes(c.key);
  if (!shiftImplicit && c.shift !== e.shiftKey) return false;
  return true;
}

/** True when the keyboard event originates in a text-editing context (native
 *  undo applies there — builder DEF-6 / architect amendment 3). Shared by
 *  every registry keydown owner (chassis + the workflow builder, CV-2). */
export function inTextContext(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const RESERVED = ['mod+k'];

/** Merge chassis defaults with definition extras. Collisions (same normalized
 *  combo) and reserved combos drop the EXTRA with a dev warning. */
export function mergeShortcuts(defaults: ShortcutDef[], extras: ShortcutDef[]): ShortcutDef[] {
  const norm = (c: string): string => {
    const p = parseCombo(c);
    return `${p.mod ? 'mod+' : ''}${p.alt ? 'alt+' : ''}${p.shift ? 'shift+' : ''}${p.key}`;
  };
  const taken = new Set(defaults.map((d) => norm(d.combo)));
  const out = [...defaults];
  for (const x of extras) {
    const n = norm(x.combo);
    if (taken.has(n) || RESERVED.includes(n)) {
      if (import.meta.env.DEV) console.warn(`[canvas] shortcut '${x.combo}' collides with a chassis default or reserved combo — dropped`);
      continue;
    }
    taken.add(n);
    out.push(x);
  }
  return out;
}

/** The dispatch used by the chassis keydown owner. Returns true when handled. */
export function dispatchShortcut(e: KeyboardEvent, shortcuts: readonly ShortcutDef[]): boolean {
  for (const s of shortcuts) {
    if (s.enabled && !s.enabled()) continue;
    if (eventMatches(e, parseCombo(s.combo))) {
      e.preventDefault();
      s.run(e);
      return true;
    }
  }
  return false;
}

/** Human-readable combo for the cheatsheet (⌘ on mac, Ctrl elsewhere). */
export function comboLabel(combo: string, isMac: boolean): string {
  const p = parseCombo(combo);
  const parts: string[] = [];
  if (p.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (p.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (p.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(p.key === 'escape' ? 'Esc' : p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1));
  return parts.join(isMac ? '' : '+');
}
