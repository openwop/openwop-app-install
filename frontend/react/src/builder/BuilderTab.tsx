/**
 * Builder route entry. Loads the workflow named by `:workflowId` from
 * localStorage, or hydrates a blank workflow under that id if none
 * exists yet (lets the dashboard mint a fresh id and link straight in).
 * The dashboard at `/builder` owns the "pick most recent" decision.
 */

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BuilderShell } from './BuilderShell.js';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { loadWorkflow as loadBackendWorkflow } from './persistence/backendStore.js';
import i18n from '../i18n/index.js';

export function BuilderTab() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const nav = useNavigate();

  useEffect(() => {
    if (!workflowId) {
      // Defensive: this route always has :workflowId; the index route is
      // the dashboard. If we land here without one, kick back to the list.
      nav('/builder', { replace: true });
      return;
    }
    let cancelled = false;
    void (async () => {
      // ADR 0163 Phase 3 — backend-first load (the per-tenant ownership index),
      // with a localStorage draft fallback baked into loadBackendWorkflow (R-D).
      // A freshly-minted id resolves to neither → a blank workflow under that id.
      const existing = await loadBackendWorkflow(workflowId);
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
      });
    })();
    return () => { cancelled = true; };
  }, [workflowId, nav]);

  function onNewWorkflow() {
    nav(`/builder/${newWorkflowId()}`);
  }

  return <BuilderShell onNewWorkflow={onNewWorkflow} />;
}
