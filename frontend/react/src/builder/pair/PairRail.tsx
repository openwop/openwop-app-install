/**
 * ADR 0773 D1 — the builder's right rail: ONE rail, two tabs (Pair · Inspect),
 * joined by the selection. Structure stays left and properties stay right
 * (DESIGN.md §7.1.5); the conversation shares the properties rail because the
 * selection is what both of them are about.
 *
 * Both panels stay MOUNTED (the inactive one is `hidden`), so switching tabs
 * never drops the chat's in-flight turn or the Inspector's field focus state.
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { startNarration } from './narrate.js';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Inspector } from '../inspector/Inspector.js';
import { PairPanel } from './PairPanel.js';
import { QuickAsk } from './QuickAsk.js';
import { usePairStore, type RailTab } from './pairStore.js';

const TABS: readonly RailTab[] = ['pair', 'inspect'];

export function PairRail(): JSX.Element {
  const { t } = useTranslation('builder');
  const tab = usePairStore((s) => s.tab);
  const setTab = usePairStore((s) => s.setTab);
  const pending = usePairStore((s) => s.opState.filter((x) => x === 'pending').length);
  const refs = useRef<Record<RailTab, HTMLButtonElement | null>>({ pair: null, inspect: null });
  // G-06a — narrate the person's own edits while the rail is mounted.
  useEffect(() => startNarration(), []);

  // Roving arrow keys between the two tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next = e.key === 'Home' ? TABS[0]! : e.key === 'End' ? TABS[TABS.length - 1]! : TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="pair-rail">
      <div className="pair-rail__tabs segmented" role="tablist" aria-label={t('pairRailTabsAria')} onKeyDown={onKeyDown}>
        {TABS.map((id) => (
          <Button
            key={id}
            ref={(el) => { refs.current[id] = el; }}
            variant="quiet"
            size="sm"
            role="tab"
            id={`pair-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`pair-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`pair-rail__tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {id === 'pair' ? t('pairTabPair') : t('pairTabInspect')}
            {id === 'pair' && pending > 0 ? (
              <>
                <span className="pair-rail__count" aria-hidden>{pending}</span>
                <span className="sr-only">{t('pairPendingAria', { count: pending })}</span>
              </>
            ) : null}
          </Button>
        ))}
      </div>
      <div id="pair-panel-pair" role="tabpanel" aria-labelledby="pair-tab-pair" className="pair-rail__panel" hidden={tab !== 'pair'}>
        <PairPanel />
      </div>
      <div id="pair-panel-inspect" role="tabpanel" aria-labelledby="pair-tab-inspect" className="pair-rail__panel pair-rail__panel--inspect" hidden={tab !== 'inspect'}>
        <div className="pair-rail__inspect-body"><Inspector /></div>
        {/* The composer stays docked in both tabs; asking from here opens Pair. */}
        <QuickAsk />
      </div>
    </div>
  );
}
