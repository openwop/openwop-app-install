/**
 * ADR 0845 D6 — approve what you see. The strategy-activation card renders the content
 * the approval binds to (every digested field, including a KR's metric source), on
 * BOTH deciding surfaces, and says so honestly for a legacy row with no snapshot.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategyActivationSnapshot } from '../ContentReviewContext.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(here, '..', p), 'utf8');

describe('ADR 0845 D6 — the strategy approval card shows what is approved', () => {
  it('renders objectives, key results, target and the metric source, plus a link', () => {
    render(
      <MemoryRouter>
        <StrategyActivationSnapshot
          strategyId="s1"
          snapshot={{
            orgId: 'o1', scope: 'org', planningHorizon: 'year', period: { label: 'FY27' }, accountableExecutive: 'Dana',
            objectives: [{ id: 'ob', title: 'Grow ARR', keyResults: [{ id: 'k', title: 'ARR to 10M', target: '10', unit: 'M', measure: { kind: 'currency', source: { kind: 'crm-deal-total', orgId: 'o1' } } }] }],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Grow ARR')).toBeTruthy();
    expect(screen.getByText(/ARR to 10M/)).toBeTruthy();
    expect(screen.getByText(/crm-deal-total/)).toBeTruthy();
    expect(screen.getByText(/FY27/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/strategy/s1');
    expect(screen.queryByRole('region'), 'one named region per card multiplies landmarks').toBeNull();
  });

  it('a legacy row with no snapshot says so instead of an empty list', () => {
    render(<MemoryRouter><StrategyActivationSnapshot strategyId="s1" /></MemoryRouter>);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('a long plan folds so the decide bar stays reachable', () => {
    const objectives = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, title: `Objective ${i}`, keyResults: [] }));
    const { container } = render(<MemoryRouter><StrategyActivationSnapshot strategyId="s1" snapshot={{ orgId: 'o', scope: 'org', planningHorizon: 'year', accountableExecutive: null, objectives }} /></MemoryRouter>);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  });

  it('both deciding surfaces render it', () => {
    for (const f of ['ApprovalsInbox.tsx', 'NeedsYouInbox.tsx']) {
      expect(read(f), f).toContain('<StrategyActivationSnapshot');
    }
  });

  it('copy exists in all four locales', () => {
    for (const loc of ['en', 'es', 'fr', 'pt-BR']) {
      for (const k of ['strategySnapshotLabel', 'strategySnapshotOpen', 'strategySnapshotLegacy', 'strategySnapshotSource']) {
        expect(read(`i18n/${loc}.ts`), `${loc}:${k}`).toContain(`${k}:`);
      }
    }
  });
});
