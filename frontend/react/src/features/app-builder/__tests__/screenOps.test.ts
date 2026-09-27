/**
 * Screen-management invariants (ADR 0305 Phase B): single home screen,
 * connector cascade on delete, last-screen guard, deterministic ids.
 */
import { describe, it, expect } from 'vitest';
import {
  addScreen, addScreenFromTemplate, renameScreen, duplicateScreen, deleteScreen, reorderScreen,
  setHomeScreen, nextScreenId, MAX_SCREENS, type AppDoc,
insertKitContent,
} from '../screenOps.js';

const base = (): AppDoc => ({
  name: 'App',
  screens: [
    { id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text' }] },
    { id: 'about', name: 'About', components: [] },
  ],
  connectors: [
    { from: 'home', to: 'about', trigger: 'tap' },
    { from: 'about', to: 'home' },
  ],
});

describe('screenOps.nextScreenId', () => {
  it('slugs the name and dedups deterministically (no clock/random)', () => {
    const screens = base().screens;
    expect(nextScreenId(screens, 'Settings Page')).toBe('settings-page');
    expect(nextScreenId(screens, 'Home')).toBe('home-2');
    expect(nextScreenId([...screens, { id: 'home-2', name: 'x' }], 'Home')).toBe('home-3');
    expect(nextScreenId([], '!!!')).toBe('screen');
  });
});

describe('screenOps.addScreen', () => {
  it('appends with a route and returns the index', () => {
    const a = base();
    const i = addScreen(a, 'Profile');
    expect(i).toBe(2);
    expect(a.screens[2]).toMatchObject({ id: 'profile', route: '/profile', components: [] });
    expect(a.screens[2]?.isInitial).toBeUndefined();
  });
  it('marks the very first screen as home and enforces the cap', () => {
    const a: AppDoc = { name: 'A', screens: [] };
    expect(addScreen(a, 'First')).toBe(0);
    expect(a.screens[0]?.isInitial).toBe(true);
    a.screens = Array.from({ length: MAX_SCREENS }, (_, n) => ({ id: `s${n}`, name: `S${n}` }));
    expect(addScreen(a, 'Over')).toBe(-1);
  });
});

describe('screenOps.duplicateScreen', () => {
  it('deep-clones after the original and NEVER copies the home flag', () => {
    const a = base();
    const i = duplicateScreen(a, 0);
    expect(i).toBe(1);
    expect(a.screens[1]?.id).toBe('home-copy');
    expect(a.screens[1]?.isInitial).toBeUndefined(); // single-home invariant
    a.screens[1]!.components!.push({ type: 'badge' });
    expect(a.screens[0]?.components?.length).toBe(1); // deep clone
  });
});

describe('screenOps.deleteScreen', () => {
  it('cascades connectors referencing the deleted screen', () => {
    const a = base();
    expect(deleteScreen(a, 1)).toBe(true);
    expect(a.screens.map((s) => s.id)).toEqual(['home']);
    expect(a.connectors).toEqual([]); // both referenced "about"
  });
  it('reassigns home when the home screen is deleted', () => {
    const a = base();
    expect(deleteScreen(a, 0)).toBe(true);
    expect(a.screens[0]?.id).toBe('about');
    expect(a.screens[0]?.isInitial).toBe(true);
  });
  it('refuses to delete the last screen', () => {
    const a = base();
    deleteScreen(a, 1);
    expect(deleteScreen(a, 0)).toBe(false);
    expect(a.screens.length).toBe(1);
  });
});

describe('screenOps.addScreenFromTemplate (ADR 0305 Phase F)', () => {
  const tpl = { name: 'Dashboard', components: [{ type: 'stack', children: [{ type: 'text', props: { text: 'hi' } }] }] };
  it('adds a new screen with a deep-cloned tree and a remapped id', () => {
    const a = base();
    const i = addScreenFromTemplate(a, tpl);
    expect(i).toBe(2);
    expect(a.screens[2]).toMatchObject({ id: 'dashboard', route: '/dashboard', name: 'Dashboard' });
    // Deep clone — mutating the instance leaves the template untouched.
    a.screens[2]!.components![0]!.children!.push({ type: 'divider' });
    expect(tpl.components[0]!.children!.length).toBe(1);
  });
  it('dedups ids when the same template is added twice, and respects the cap', () => {
    const a = base();
    addScreenFromTemplate(a, tpl);
    addScreenFromTemplate(a, tpl);
    expect(a.screens.map((s) => s.id)).toContain('dashboard-2');
    a.screens = Array.from({ length: MAX_SCREENS }, (_, n) => ({ id: `s${n}`, name: `S${n}` }));
    expect(addScreenFromTemplate(a, tpl)).toBe(-1);
  });
  it('marks the first screen of an empty app as home', () => {
    const a: AppDoc = { name: 'A', screens: [] };
    addScreenFromTemplate(a, tpl);
    expect(a.screens[0]?.isInitial).toBe(true);
  });
});

describe('screenOps.reorderScreen + setHomeScreen + renameScreen', () => {
  it('reorders with clamping', () => {
    const a = base();
    reorderScreen(a, 0, 99);
    expect(a.screens.map((s) => s.id)).toEqual(['about', 'home']);
  });
  it('keeps exactly one home screen', () => {
    const a = base();
    setHomeScreen(a, 1);
    expect(a.screens.map((s) => Boolean(s.isInitial))).toEqual([false, true]);
  });
  it('renames the display name only (id stable for connectors)', () => {
    const a = base();
    renameScreen(a, 0, '  Start  ');
    expect(a.screens[0]?.name).toBe('Start');
    expect(a.screens[0]?.id).toBe('home');
    renameScreen(a, 0, '   ');
    expect(a.screens[0]?.name).toBe('Start'); // blank rejected
  });
});

describe('insertKitContent (ADR 0347 5a)', () => {
  const kit = {
    screens: [
      { id: 'kit-signin', name: 'Sign in', route: '/signin', x: 80, y: 80, isInitial: true,
        components: [{ type: 'link', props: { label: 'Reset', navigateTo: 'kit-reset' } }] },
      { id: 'kit-reset', name: 'Reset', route: '/reset', x: 420, y: 80, components: [] },
    ],
    connectors: [{ from: 'kit-signin', to: 'kit-reset', trigger: 'click' }],
  };
  it('inserts below the existing flow with remapped ids, nav, and connectors', () => {
    const app: AppDoc = {
      name: 'App',
      screens: [{ id: 'home', name: 'Home', isInitial: true, y: 100, components: [] }, { id: 'kit-signin', name: 'Taken', y: 100, components: [] }],
      connectors: [],
    };
    insertKitContent(app, JSON.parse(JSON.stringify(kit)));
    const ids = app.screens.map((s) => s.id);
    expect(ids).toEqual(['home', 'kit-signin', 'kit-signin-2', 'kit-reset']);
    const inserted = app.screens[2]!;
    expect(inserted.isInitial).toBeUndefined();                    // ONE home stays
    expect(inserted.route).toBe('/kit-signin-2');                  // route restamped
    expect(inserted.y).toBeGreaterThan(100);                       // offset below
    expect(inserted.components![0]!.props!.navigateTo).toBe('kit-reset'); // nav follows the remap
    expect(app.connectors).toEqual([{ from: 'kit-signin-2', to: 'kit-reset', trigger: 'click' }]);
  });
  it('never mutates the caller-shared kit definition', () => {
    const app: AppDoc = { name: 'A', screens: [], connectors: [] };
    const frozen = JSON.stringify(kit);
    expect(insertKitContent(app, kit as never)).toBe(true);
    expect(JSON.stringify(kit)).toBe(frozen);
  });
  it('rejects (doc untouched) when the insert would exceed the screen cap', () => {
    const app: AppDoc = {
      name: 'Full',
      screens: Array.from({ length: 59 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, ...(i === 0 ? { isInitial: true } : {}), components: [] })),
      connectors: [],
    };
    const before = JSON.stringify(app);
    expect(insertKitContent(app, JSON.parse(JSON.stringify(kit)))).toBe(false);
    expect(JSON.stringify(app)).toBe(before);
  });
});
