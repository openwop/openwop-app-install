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
    expect(a.screens[2]).toEqual({ id: 'profile', name: 'Profile', route: '/profile', components: [] });
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
    // No isInitial (single-home invariant); the route is RESTAMPED to the new id.
    expect(a.screens[1]).toEqual({ id: 'home-copy', name: 'Home copy', route: '/home-copy', components: [{ type: 'text' }] });
    a.screens[1]!.components!.push({ type: 'badge' });
    expect(a.screens[0]?.components?.length).toBe(1); // deep clone
  });
});

describe('screenOps.deleteScreen', () => {
  it('cascades connectors referencing the deleted screen', () => {
    const a = base();
    // An UNRELATED connector must survive — without it, wiping every connector
    // would satisfy the assertion (w36 probe).
    a.screens.push({ id: 'x', name: 'X', components: [] });
    a.connectors!.push({ from: 'home', to: 'x' });
    expect(deleteScreen(a, 1)).toBe(true);
    expect(a.screens.map((s) => s.id)).toEqual(['home', 'x']);
    expect(a.connectors).toEqual([{ from: 'home', to: 'x' }]); // both "about" edges gone
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
      // BOTH kit ids are taken, so both remap — an identity remap could not
      // show that nav + connectors follow it (w36 probe).
      screens: [
        { id: 'home', name: 'Home', isInitial: true, y: 100, components: [] },
        { id: 'kit-signin', name: 'Taken', y: 100, components: [] },
        { id: 'kit-reset', name: 'Taken too', y: 60, components: [] },
      ],
      connectors: [],
    };
    expect(insertKitContent(app, JSON.parse(JSON.stringify(kit)))).toBe(true);
    expect(app.screens.map((s) => s.id)).toEqual(['home', 'kit-signin', 'kit-reset', 'kit-signin-2', 'kit-reset-2']);
    // ONE home stays (isInitial dropped), route restamped, y offset below the
    // lowest existing screen: max(100,100,60) + 520 + kit y 80 = 700.
    expect(app.screens[3]).toEqual({
      id: 'kit-signin-2', name: 'Sign in', route: '/kit-signin-2', x: 80, y: 700,
      components: [{ type: 'link', props: { label: 'Reset', navigateTo: 'kit-reset-2' } }],
    });
    expect(app.screens[4]).toEqual({ id: 'kit-reset-2', name: 'Reset', route: '/kit-reset-2', x: 420, y: 700, components: [] });
    expect(app.connectors).toEqual([{ from: 'kit-signin-2', to: 'kit-reset-2', trigger: 'click' }]);
  });
  it('never mutates the caller-shared kit definition', () => {
    const app: AppDoc = { name: 'A', screens: [], connectors: [] };
    const frozen = JSON.stringify(kit);
    expect(insertKitContent(app, kit)).toBe(true);
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
  it('accepts an insert that lands EXACTLY on the screen cap', () => {
    // 58 + 2 = MAX_SCREENS (60) is legal; only 61+ is refused.
    const app: AppDoc = {
      name: 'Edge',
      screens: Array.from({ length: 58 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, components: [] })),
      connectors: [],
    };
    expect(insertKitContent(app, JSON.parse(JSON.stringify(kit)))).toBe(true);
    expect(app.screens).toHaveLength(60);
  });
});
