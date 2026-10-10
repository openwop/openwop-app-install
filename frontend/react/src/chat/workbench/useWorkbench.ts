/**
 * useWorkbench — ADR 0768 P2 state for the chat's right-hand Workbench pane
 * ("talk left, work right"). Independent of the left rail, so the thread list
 * and the workbench can be open together — the reason this is its own state
 * rather than another `LeftRailTab` value.
 *
 * Persisted per tenant: only the `run` tab survives a reload. An artifact tab
 * needs an artifact id, which is session-local, so it is never restored empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type WorkbenchTab = 'run' | 'artifact' | 'sources';
export interface WorkbenchArtifact { artifactId: string; revisionId?: string }

export interface WorkbenchState {
  tab: WorkbenchTab | null;
  artifact: WorkbenchArtifact | null;
  openRun: () => void;
  openArtifact: (a: WorkbenchArtifact) => void;
  select: (tab: WorkbenchTab | null) => void;
  close: () => void;
  /** Drop the artifact (its own close); falls back to Run, or shuts the pane. */
  closeArtifact: (runsAvailable: boolean) => void;
}

export const workbenchKey = (tenantId: string): string => `openwop-app.chat.workbench:${tenantId}`;

export function readWorkbenchTab(tenantId: string | null): WorkbenchTab | null {
  if (tenantId === null) return null;
  try { return localStorage.getItem(workbenchKey(tenantId)) === 'run' ? 'run' : null; } catch { return null; }
}

/** `tenantId: null` = do not persist (the multi-tab deck, which is keyed per
 *  user by remount and keeps no per-tenant rail state either). */
export function useWorkbench(tenantId: string | null, initialTab: WorkbenchTab | null = null): WorkbenchState {
  const [tab, setTab] = useState<WorkbenchTab | null>(() => initialTab ?? readWorkbenchTab(tenantId));
  const [artifact, setArtifact] = useState<WorkbenchArtifact | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    try {
      if (tab === 'run') localStorage.setItem(workbenchKey(tenantId), 'run');
      else localStorage.removeItem(workbenchKey(tenantId));
    } catch { /* storage disabled — the pane still works for this visit */ }
  }, [tenantId, tab]);

  const openRun = useCallback(() => setTab('run'), []);
  const openArtifact = useCallback((a: WorkbenchArtifact) => { setArtifact(a); setTab('artifact'); }, []);
  const select = useCallback((next: WorkbenchTab | null) => setTab(next), []);
  const close = useCallback(() => setTab(null), []);
  const closeArtifact = useCallback((runsAvailable: boolean) => {
    setArtifact(null);
    setTab(runsAvailable ? 'run' : null);
  }, []);

  // An artifact tab without an artifact is not a state the pane can show.
  const effectiveTab = tab === 'artifact' && !artifact ? null : tab;
  return { tab: effectiveTab, artifact, openRun, openArtifact, select, close, closeArtifact };
}

/**
 * ADR 0768 P6 — on a phone the rail and the Workbench each cover the thread, so
 * at most one is open. When both end up open, keep the one that JUST opened
 * (the user's latest intent) and close the other. Shared by both chat shells so
 * the rule cannot drift between them. A no-op above the mobile breakpoint.
 */
export function useMobilePaneArbitration(
  isMobile: boolean,
  railOpen: boolean,
  workbenchOpen: boolean,
  closeRail: () => void,
  closeWorkbench: () => void,
): void {
  const prev = useRef({ rail: railOpen, workbench: workbenchOpen });
  useEffect(() => {
    const was = prev.current;
    prev.current = { rail: railOpen, workbench: workbenchOpen };
    if (!isMobile || !railOpen || !workbenchOpen) return;
    if (!was.workbench) closeRail();
    else if (!was.rail) closeWorkbench();
    else closeRail(); // both were already open (e.g. a resize into mobile): favour the work
  }, [isMobile, railOpen, workbenchOpen, closeRail, closeWorkbench]);
}
