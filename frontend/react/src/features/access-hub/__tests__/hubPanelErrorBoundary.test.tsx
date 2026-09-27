/**
 * ADR 0715 — a hub panel catches SUSPENSION but not FAILURE.
 *
 * `<Suspense>` handles a lazy pane while it loads. A rejected dynamic import is an
 * ERROR, not a suspension, so it passes straight through. Before this ADR every
 * projection console wrapped its panel in `<Suspense>` and nothing else, so one failed
 * chunk unwound to the page boundary and replaced the WHOLE console.
 *
 * Two legs are behavioural and one is structural, and they guard different things:
 *
 *  - the behavioural legs pin the DESIGN DECISION that is easy to get wrong — the
 *    boundary must key on the ACTIVE TAB. `App.tsx`/`SiteShell.tsx` key on
 *    `resetKey={location.pathname}`, and hub tabs are a QUERY PARAM (`useUrlTab` ->
 *    `useSearchParams`), so a pathname-keyed boundary never resets on a tab change.
 *    Leg 2 is the control that proves that claim rather than asserting it: the same
 *    component with a CONSTANT resetKey stays broken.
 *  - the structural leg pins the POPULATION. `AHU-1` was filed against one page; the
 *    measured class was six panel sites across five files, including the very page
 *    cited as the correct precedent. A behavioural leg on one console cannot see a new
 *    console shipping without a boundary.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorBoundary } from '../../../ui/index.js';

/** Strip JSX/line comments before counting, so the ratchet measures CODE not prose.
 *  The first version of this file did not, and it failed on its own fix: the ADR 0715
 *  docblock added to each console literally contains "`<Suspense>` catches SUSPENSION",
 *  which a naive `match(/<Suspense/g)` counts as a render site. A structural ratchet that
 *  reads comments is measuring the wrong artifact — it would go red or green on wording. */
function code(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A pane that throws for exactly one tab id — a failed chunk for that destination. */
function Pane({ tab }: { tab: string }): JSX.Element {
  if (tab === 'broken') throw new Error('Failed to fetch dynamically imported module');
  return <p>pane:{tab}</p>;
}

/** The shape a hub renders: a persistent tab strip + a guarded panel. */
function Console({ keyed }: { keyed: 'tab' | 'constant' }): JSX.Element {
  const [tab, setTab] = useState('broken');
  return (
    <div>
      <button onClick={() => setTab('healthy')}>go-healthy</button>
      <p>tabstrip</p>
      <ErrorBoundary resetKey={keyed === 'tab' ? tab : '/access'} fallback={() => <p>panel-error</p>}>
        <Pane tab={tab} />
      </ErrorBoundary>
    </div>
  );
}

describe('ADR 0715 D1 — the panel boundary is scoped to the tab', () => {
  it('leg 1: a failed pane shows a panel error AND the console survives; moving to a healthy tab clears it', () => {
    render(<Console keyed="tab" />);
    // Scoped, not page-wide: the strip is still there beside the error.
    expect(screen.getByText('panel-error')).toBeTruthy();
    expect(screen.getByText('tabstrip'), 'the console must survive a failed pane').toBeTruthy();

    fireEvent.click(screen.getByText('go-healthy'));
    expect(screen.getByText('pane:healthy'), 'a tab change must clear the caught error').toBeTruthy();
    expect(screen.queryByText('panel-error')).toBeNull();
  });

  it('leg 2 (CONTROL): a boundary keyed on a CONSTANT — what pathname-keying gives you — stays wedged', () => {
    // This is the measured reason the page-level boundary cannot serve a hub: hub tabs
    // never change `location.pathname`, so its resetKey never changes. Without this leg,
    // leg 1 would pass just as well with a pathname-keyed boundary and the ADR's central
    // design claim would be untested.
    render(<Console keyed="constant" />);
    expect(screen.getByText('panel-error')).toBeTruthy();
    fireEvent.click(screen.getByText('go-healthy'));
    expect(screen.queryByText('pane:healthy'), 'a constant resetKey cannot recover').toBeNull();
    expect(screen.getByText('panel-error')).toBeTruthy();
  });
});

describe('ADR 0715 D1 — the POPULATION: every console panel is guarded', () => {
  // The five files measured in the ADR. `AHU-1` was filed against the first one only.
  const PANEL_FILES = [
    'features/access-hub/AccessHubPage.tsx',
    'features/models/ModelsHubPage.tsx',
    'features/chat-deployment/ChatDeploymentHubPage.tsx',
    'features/campaigns/CampaignStudioHubPage.tsx',
    'features/settings-shell/SettingsPage.tsx',
  ];

  it('non-vacuity: every listed file exists and really renders a lazy panel', () => {
    // Without this, a renamed file would silently drop out of the ratchet below and the
    // whole block would pass while guarding nothing.
    for (const f of PANEL_FILES) {
      const src = code(readFileSync(join(SRC, f), 'utf8'));
      expect(src, `${f} must exist and still render a <Suspense> panel`).toContain('<Suspense');
    }
  });

  it('every <Suspense> panel site is wrapped in an <ErrorBoundary>', () => {
    for (const f of PANEL_FILES) {
      const src = code(readFileSync(join(SRC, f), 'utf8'));
      const suspense = (src.match(/<Suspense/g) ?? []).length;
      const boundaries = (src.match(/<ErrorBoundary/g) ?? []).length;
      expect(boundaries, `${f}: ${suspense} <Suspense> site(s) but ${boundaries} <ErrorBoundary>`).toBeGreaterThanOrEqual(suspense);
    }
  });

  it('each boundary keys on the ACTIVE TAB, never on a pathname', () => {
    // The defect leg 2 demonstrates, pinned structurally: a console that keys its panel
    // boundary on the route path is wedge-prone, and that is the easy mistake to copy
    // from `App.tsx`.
    for (const f of PANEL_FILES) {
      const src = code(readFileSync(join(SRC, f), 'utf8'));
      expect(src, `${f} must not key a panel boundary on the pathname`).not.toMatch(/<ErrorBoundary[^>]*resetKey=\{location\.pathname\}/);
      expect(src, `${f} must pass a resetKey`).toMatch(/<ErrorBoundary[^>]*resetKey=/);
    }
  });
});
