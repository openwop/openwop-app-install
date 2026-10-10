/**
 * Builder route entry. Loads the workflow named by `:workflowId` from
 * localStorage, or hydrates a blank workflow under that id if none
 * exists yet (lets the dashboard mint a fresh id and link straight in).
 * The dashboard at `/builder` owns the "pick most recent" decision.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BuilderShell } from './BuilderShell.js';
import { useBuilderStore, flushPendingBackendSync, consumeAdoptedFork, resolveForkAlias } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { loadWorkflowWithHead, LoadOfflineError, LoadRefusedError } from './persistence/backendStore.js';
import { CanonicalParseError } from './schema/deserialize.js';
import { StateCard } from '../ui/StateCard.js';
import { WorkflowIcon } from '../ui/icons/index.js';
import i18n from '../i18n/index.js';

export function BuilderTab() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const nav = useNavigate();
  const { t } = useTranslation('builder');
  const [loadError, setLoadError] = useState<string | null>(null);
  // ADR 0770 D6 — a refused/offline read is RETRYABLE (unlike an unparseable
  // definition), so its card offers Retry; bumping this re-runs the load.
  const [retryable, setRetryable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // ADR 0770 D6 (BLD-17) — until the store holds THIS id, the canvas would show
  // (and autosave edits into) the PREVIOUS workflow. Render a loading card.
  const loadedId = useBuilderStore((s) => s.workflowId);

  // ADR 0770 D6 (`WBWF-12`) — the autosave trails the last edit by 1.5s; a tab
  // closed inside that window lost the edit. Flush on `pagehide` (keepalive).
  useEffect(() => {
    const onPageHide = (): void => flushPendingBackendSync({ keepalive: true });
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ADR 0789 — the store adopted a fork of a shared (seeded) workflow: follow it
  // in the URL so a reload, a bookmark or a shared link opens the tenant's copy.
  const followedFork = useRef<string | null>(null);
  useEffect(() => {
    if (workflowId && loadedId && loadedId !== workflowId && consumeAdoptedFork(loadedId)) {
      followedFork.current = loadedId;
      nav(`/builder/${loadedId}`, { replace: true });
    }
  }, [loadedId, workflowId, nav]);

  useEffect(() => {
    if (!workflowId) {
      // Defensive: this route always has :workflowId; the index route is
      // the dashboard. If we land here without one, kick back to the list.
      nav('/builder', { replace: true });
      return;
    }
    // ADR 0789 — arriving here because the store adopted a fork: the canvas
    // already holds it (with any edits made since that save), so do not reload.
    // ADR 0789 — this session already forked that shared workflow: open the
    // tenant's copy, never the shared original it no longer owns.
    const alias = resolveForkAlias(workflowId);
    if (alias !== workflowId) {
      nav(`/builder/${alias}`, { replace: true });
      return;
    }
    if (followedFork.current === workflowId && useBuilderStore.getState().workflowId === workflowId) {
      followedFork.current = null;
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setRetryable(false);
    void (async () => {
      // ADR 0163 Phase 3 — backend-first load (the per-tenant ownership index),
      // with a localStorage draft fallback baked into loadBackendWorkflow (R-D).
      // A freshly-minted id resolves to neither → a blank workflow under that id.
      // A definition the builder CAN'T open (CanonicalParseError — e.g. a node
      // type this host doesn't have installed) renders an error state instead of
      // silently minting a blank canvas over a real workflow.
      try {
        // `null` now means an AUTHORITATIVE not-found only (ADR 0770 D6): a refused
        // or offline read throws below instead of minting a blank canvas over a
        // workflow that exists — the first autosave used to overwrite it.
        // ADR 0770 D5 — the content and the head it edits against (the save's
        // If-Match) come from ONE fresh server read.
        const { workflow: existing, headRevision } = await loadWorkflowWithHead(workflowId);
        if (cancelled) return;
        useBuilderStore.getState().loadFromSaved(existing ?? {
          id: workflowId,
          name: i18n.t('builder:untitledWorkflow'),
          version: '1.0.0',
          nodes: [],
          edges: [],
          defaultInputs: '{}',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          // ADR 0369 §5 — Workflow Builder → Dynamic → Saved: a fresh canvas
          // is a transient draft (catalog-hidden from birth) until promoted.
          lifecycle: { transient: true, generatedBy: 'workflow-builder' },
        });
        useBuilderStore.getState().setBaseRevision(headRevision);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CanonicalParseError) {
          setLoadError(err.message);
          return;
        }
        if (err instanceof LoadRefusedError || err instanceof LoadOfflineError) {
          setLoadError(err.message);
          setRetryable(true);
          return;
        }
        throw err;
      }
    })();
    return () => { cancelled = true; };
  }, [workflowId, nav, attempt]);

  function onNewWorkflow() {
    nav(`/builder/${newWorkflowId()}`);
  }

  if (loadError) {
    return (
      <StateCard announce
        icon={<WorkflowIcon size={20} />}
        title={t('loadErrorTitle')}
        body={loadError}
        action={
          <>
            {retryable ? (
              <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                {t('loadErrorRetry')}
              </Button>
            ) : null}
            <Button variant={retryable ? 'quiet' : 'primary'} onClick={() => nav('/builder')}>
              {t('loadErrorBackToWorkflows')}
            </Button>
          </>
        }
      />
    );
  }

  if (workflowId && loadedId !== workflowId) {
    return (
      <StateCard
        icon={<WorkflowIcon size={20} />}
        title={t('loadingWorkflow')}
        loading
      />
    );
  }

  return <BuilderShell onNewWorkflow={onNewWorkflow} />;
}
