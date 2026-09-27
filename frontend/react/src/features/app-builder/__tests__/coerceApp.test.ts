/**
 * ADR 0342 Phase 0 (DS-01/DA-01) — the editor round-trip parity fixture. The
 * editor loads THROUGH `coerceApp` and saves its result, so any recognized
 * document field the coercion drops is PERMANENT data loss on first save (this
 * is exactly how AI-generated theme colors and data sources were being lost).
 * The fixture mirrors what the `app-builder.design` chain emits: every field of
 * the artifact schema, populated. Coercion must preserve them all, deep-equal.
 */
import { describe, it, expect } from 'vitest';
import { coerceApp } from '../definition.js';

/** Every recognized `canvas.app-builder` facet, populated the way the design
 *  workflow emits them (screens carry board positions + component trees). */
const designWorkflowDoc = {
  name: 'Aurora Fitness',
  description: 'A wellness companion app.',
  theme: 'dark',
  themeColors: { primary: '#7c5cff', secondary: '#22d3ee' },
  // ADR 0343 — the comprehensive-document facets ride the same round trip.
  schemaVersion: 1,
  designSystemRef: { id: 'ds_aurora', mode: 'linked' },
  brandRef: { id: 'brand_aurora' },
  stateVariables: [{ id: 'filter', type: 'string', initial: 'all' }],
  models: [{ id: 'workout', name: 'Workout', fields: [{ name: 'title', type: 'string', required: true }] }],
  operations: [{ id: 'listWorkouts', name: 'List workouts', kind: 'list', modelId: 'workout', output: { type: 'modelList' } }],
  authProfile: { kind: 'email-password', roles: ['member'], guards: [{ screenId: 'home', requiresRole: 'member' }] },
  envRequirements: [{ key: 'API_BASE_URL', purpose: 'Backend origin.', requiredFor: ['runtime'] }],
  componentDefinitions: [{ id: 'row', name: 'Row', root: { type: 'text', props: { text: '{{title}}' } } }],
  screens: [
    {
      id: 'home', name: 'Home', route: '/home', isInitial: true, x: 80, y: 120,
      components: [
        { type: 'heading', props: { text: 'Welcome back' } },
        { type: 'list', props: { bind: 'workouts' }, children: [{ type: 'text', props: { text: '{{title}}' } }] },
        { type: 'image', props: { src: 'https://example.com/hero.jpg', alt: 'Hero' } },
      ],
    },
    { id: 'detail', name: 'Detail', route: '/detail', x: 420, y: 120, components: [] },
  ],
  connectors: [
    { from: 'home', to: 'detail', trigger: 'click', label: 'Open', sourceEdge: 'right', targetEdge: 'left', transition: 'push', routingStyle: 'bezier', animated: true },
  ],
  dataSources: [
    { id: 'workouts', name: 'Workouts', fields: ['title', 'duration'], rows: [{ title: 'Morning run', duration: '30m' }, { title: 'Yoga', duration: '20m' }] },
  ],
} satisfies Record<string, unknown>;

describe('coerceApp — round-trip parity (ADR 0342 Phase 0)', () => {
  it('preserves EVERY recognized document field, deep-equal', () => {
    const coerced = coerceApp(designWorkflowDoc);
    // Deep equality over the whole document — a new schema facet that coercion
    // drops fails HERE, not in production data loss.
    expect(coerced).toEqual(designWorkflowDoc);
  });

  it('round-trips through serialize → parse → coerce unchanged (the save path)', () => {
    const once = coerceApp(designWorkflowDoc);
    const twice = coerceApp(JSON.parse(JSON.stringify(once)) as Record<string, unknown>);
    expect(twice).toEqual(designWorkflowDoc);
  });

  it('drops malformed facets instead of crashing (safe fallbacks)', () => {
    const coerced = coerceApp({ name: 42, themeColors: 'nope', dataSources: 'nope', screens: 'nope', connectors: 'nope' });
    expect(coerced).toEqual({ name: 'Untitled app', screens: [] });
  });

  it('keeps an array themeColors out (object narrowing)', () => {
    const coerced = coerceApp({ name: 'A', screens: [], themeColors: ['#ffffff'] });
    expect(coerced.themeColors).toBeUndefined();
  });
});
