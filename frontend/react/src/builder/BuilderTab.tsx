/**
 * Builder route entry. Loads the workflow named by `:workflowId` from
 * localStorage, or hydrates a blank workflow under that id if none
 * exists yet (lets the dashboard mint a fresh id and link straight in).
 * The dashboard at `/builder` owns the "pick most recent" decision.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BuilderShell } from './BuilderShell.js';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { loadWorkflow as loadBackendWorkflow } from './persistence/backendStore.js';
import { CanonicalParseError } from './schema/deserialize.js';
import { StateCard } from '../ui/StateCard.js';
import { WorkflowIcon } from '../ui/icons/index.js';
import i18n from '../i18n/index.js';

export function BuilderTab() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const nav = useNavigate();
  const { t } = useTranslation('builder');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) {
      // Defensive: this route always has :workflowId; the index route is
      // the dashboard. If we land here without one, kick back to the list.
      nav('/builder', { replace: true });
      return;
    }
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      // ADR 0163 Phase 3 — backend-first load (the per-tenant ownership index),
      // with a localStorage draft fallback baked into loadBackendWorkflow (R-D).
      // A freshly-minted id resolves to neither → a blank workflow under that id.
      // A definition the builder CAN'T open (CanonicalParseError — e.g. a node
      // type this host doesn't have installed) renders an error state instead of
      // silently minting a blank canvas over a real workflow.
      try {
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
          // ADR 0369 §5 — Workflow Builder → Dynamic → Saved: a fresh canvas
          // is a transient draft (catalog-hidden from birth) until promoted.
          lifecycle: { transient: true, generatedBy: 'workflow-builder' },
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CanonicalParseError) {
          setLoadError(err.message);
          return;
        }
        throw err;
      }
    })();
    return () => { cancelled = true; };
  }, [workflowId, nav]);

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
          <Button variant="primary" onClick={() => nav('/builder')}>
            {t('loadErrorBackToWorkflows')}
          </Button>
        }
      />
    );
  }

  return <BuilderShell onNewWorkflow={onNewWorkflow} />;
}
