/**
 * ENTU-1 (FEATURES.md ordinal 234, a11y Blocker) — the secondary ER view
 * `SchemaGraphPage` renders its content model ONLY as an `@xyflow` canvas:
 * `elementsSelectable={false}` (no keyboard node focus), edges are SVG paths
 * with visual-only labels (relationships SR-invisible), and `TypeNode` has no
 * role/aria. WCAG 2.1.1 / 1.1.1 / 1.3.1.
 *
 * The fix co-locates a screen-reader-navigable EQUIVALENT beside the canvas — a
 * real DOM list of types (+ their fields, incl. each reference field's target =
 * the graph's dashed edges) and a `<table>` of declared relationships (= the
 * solid edges). The canvas is left as the visual view (not made SR-navigable,
 * per the task — that's fragile). This witness asserts the equivalent exists and
 * conveys the same information; it is born-red (no such list/table before).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const { listEntityTypes, listRelationships } = vi.hoisted(() => ({
  listEntityTypes: vi.fn(), listRelationships: vi.fn(),
}));
vi.mock('../entitiesClient.js', async (orig) => ({
  ...(await orig<typeof import('../entitiesClient.js')>()),
  listEntityTypes, listRelationships,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
// Stub xyflow — the accessible equivalent is the surface under test, not the canvas.
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Controls: () => null,
  BackgroundVariant: { Dots: 'dots' },
}));

import { SchemaGraphPage } from '../SchemaGraphPage.js';

const TYPES = [
  {
    typeId: 't-article', tenantId: 'x', projectId: 'p', name: 'article', displayName: 'Article',
    status: 'published', createdAt: '', updatedAt: '',
    fields: [
      { key: 'title', label: 'Title', type: 'string', required: true },
      { key: 'author', label: 'Author ref', type: 'reference', required: false, refEntityType: 'author' },
    ],
  },
  {
    typeId: 't-author', tenantId: 'x', projectId: 'p', name: 'author', displayName: 'Author',
    status: 'draft', createdAt: '', updatedAt: '',
    fields: [{ key: 'name', label: 'Name', type: 'string', required: true }],
  },
];
const RELS = [
  { relId: 'r1', fromTypeId: 't-article', toTypeId: 't-author', cardinality: 'many-many', onDelete: 'restrict' },
];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listEntityTypes.mockResolvedValue(TYPES);
  listRelationships.mockResolvedValue(RELS);
});

describe('ENTU-1 — SchemaGraphPage accessible types+relationships equivalent', () => {
  it('renders an SR-navigable list of content types with their fields', async () => {
    render(<MemoryRouter><SchemaGraphPage /></MemoryRouter>);
    const region = await screen.findByTestId('schema-accessible-list');
    const typesList = within(region).getByTestId('schema-types-list');
    // Both types are enumerated in real list content.
    expect(within(typesList).getAllByText('Article').length).toBeGreaterThan(0);
    expect(within(typesList).getAllByText('Author').length).toBeGreaterThan(0);
    // A plain field and a reference field's TARGET are both readable.
    expect(within(typesList).getByText(/Title/)).toBeTruthy();
    expect(within(typesList).getByText(/→\s*Author/)).toBeTruthy(); // dashed-edge equivalent
  });

  it('exposes declared relationships as a real table (the solid edges, SR-invisible before)', async () => {
    render(<MemoryRouter><SchemaGraphPage /></MemoryRouter>);
    const region = await screen.findByTestId('schema-accessible-list');
    const table = within(region).getByRole('table');
    expect(within(table).getAllByText('Article').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Author').length).toBeGreaterThan(0);
    expect(within(table).getByText(/Many to many/i)).toBeTruthy();
    expect(within(table).getByText(/Restrict/i)).toBeTruthy();
  });

  it('marks the visual canvas decorative (aria-hidden) so it is not a redundant AT surface', async () => {
    // Adversarial-review finding: @xyflow nodes/edges default focusable+labeled,
    // so without this the canvas duplicates the list content and exposes raw
    // typeIds — the "my fix reintroduces the family" shape. The graph wrapper
    // must be aria-hidden (the list is the single accessible representation).
    render(<MemoryRouter><SchemaGraphPage /></MemoryRouter>);
    await screen.findByTestId('schema-accessible-list');
    const canvas = document.querySelector('[data-canvas-root="entities-schema"]');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-hidden')).toBe('true');
    // A decorative subtree must not advertise itself as a labeled region.
    expect(canvas!.getAttribute('role')).toBeNull();
  });

  it('does NOT use a conditionally-mounted role=status live region for the list (MTCU-201 family)', async () => {
    render(<MemoryRouter><SchemaGraphPage /></MemoryRouter>);
    const region = await screen.findByTestId('schema-accessible-list');
    expect(region.querySelector('[role="status"]')).toBeNull();
    expect(region.querySelector('[aria-live]')).toBeNull();
  });
});
