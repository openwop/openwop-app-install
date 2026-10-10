/**
 * ADR 0766 D3 / grade-ux U-1 — a node installed at a version other than the one
 * the template pinned renders as its OWN row: labelled, both versions named in
 * visible text, and the "ready to go" chip withheld. The first cut folded it into
 * the missing-node list as `typeId@pinned`, so an installed node read as "Node
 * type not installed" and the user could see neither version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChainTemplate } from '../persistence/backendStore.js';

vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useAllFeatureAccess: () => ({ byId: {} }),
}));
vi.mock('../../features/connections/connectionsClient.js', () => ({
  listConnections: () => Promise.resolve([]),
  listProviders: () => Promise.resolve([]),
}));

const { TemplatePreflightModal } = await import('../TemplatePreflightModal.js');

afterEach(cleanup);

const base: ChainTemplate = { chainId: 'c', packName: 'p', label: 'Weekly digest', description: 'd' };

function renderWith(requirements: NonNullable<ChainTemplate['requirements']>): void {
  render(
    <MemoryRouter>
      <TemplatePreflightModal chain={{ ...base, requirements }} busy={false} error={null} onConfirm={() => {}} onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe('TemplatePreflightModal — pinned-version mismatch', () => {
  it('names the node by label with both versions, and is not "ready"', () => {
    renderWith({
      missingNodeTypeIds: [], connections: [], approvalGateCount: 0,
      pinMismatches: [{ typeId: 'core.web.search', label: 'Web search', pinned: '1.0.0', installed: '1.1.0' }],
    });
    expect(screen.getByText('Web search')).toBeTruthy();
    expect(screen.getByText('core.web.search')).toBeTruthy();
    expect(screen.getByText('Different version installed')).toBeTruthy();
    expect(screen.getByText(/built for version 1\.0\.0; this host has 1\.1\.0/)).toBeTruthy();
    expect(screen.queryByText('Node type not installed')).toBeNull();
    expect(screen.queryByText(/ready to go/i)).toBeNull();
  });

  it('a template with no gaps still reads ready (control)', () => {
    renderWith({ missingNodeTypeIds: [], connections: [], approvalGateCount: 0, pinMismatches: [] });
    expect(screen.queryByText('Different version installed')).toBeNull();
    expect(screen.getByText(/ready to go/i)).toBeTruthy();
  });
});
