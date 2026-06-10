/**
 * Three-region builder layout + top toolbar.
 *
 * Toolbar: ‹ Workflows back-link, name input, [New], [Run], undo/redo.
 * Layout: palette (260px) | canvas (flex 1) | inspector (320px).
 *
 * Auto-saves to localStorage on every store mutation; no explicit Save
 * button — matches the chat session pattern (useChatSession.ts:87-113).
 * The workflow list lives at /builder (WorkflowsDashboard).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NodePalette } from './palette/NodePalette.js';
import { BuilderCanvas } from './canvas/BuilderCanvas.js';
import { Inspector } from './inspector/Inspector.js';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { registerWorkflow } from './persistence/registerClient.js';
import { serializeWithIdMap, SerializeError } from './schema/serialize.js';
import { fromCanonicalDefinition, looksCanonical } from './schema/deserialize.js';
import { buildChainPackManifest } from './schema/chainPackManifest.js';
import { createRun } from '../client/runsClient.js';
import { subscribeToRun } from '../client/streamsClient.js';
import type { SavedWorkflow } from './schema/workflow.js';
import { CheckIcon } from '../ui/icons/index.js';
import {
  useHostLimits,
  collectPreflightIssues,
  collectLimitIssues,
  formatAdvertisedLimits,
  type PreflightIssue,
  type LimitIssue,
} from './builderShellHelpers.js';
import { BuilderToolbar } from './BuilderToolbar.js';
import { PublishHelpBanner } from './PublishHelpBanner.js';
import { PreflightBanner } from './PreflightBanner.js';
import { RunOverlayBanner } from './RunOverlayBanner.js';

interface Props {
  onNewWorkflow(): void;
}

export function BuilderShell({ onNewWorkflow }: Props) {
  const nav = useNavigate();
  const workflowId = useBuilderStore((s) => s.workflowId);
  const name = useBuilderStore((s) => s.name);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const canUndo = useBuilderStore((s) => s.past.length > 0);
  const canRedo = useBuilderStore((s) => s.future.length > 0);
  const overlay = useBuilderStore((s) => s.overlay);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The Publish-to-registry helper. Non-null when the user has clicked
  // "Publish to registry…" — stores the proposed pack slug + manifest
  // size + GitHub registry URL so the inline checklist can render
  // without re-deriving on every render.
  const [publishHelp, setPublishHelp] = useState<{ slug: string; size: number; manifestJson: string } | null>(null);
  // Pre-flight issues found on the last Run click. When non-null the
  // user must confirm ("Run anyway") or cancel before the run fires.
  // `caps` are per-node missing host surfaces; `limits` are graph-shape
  // breaches of advertised engine ceilings. A "Run anyway" applies to
  // both — limit breaches will still fail at runtime, but the user may
  // want to capture the error trace.
  const [preflight, setPreflight] = useState<
    | { caps: PreflightIssue[]; limits: LimitIssue[] }
    | null
  >(null);
  // Success summary from the last Validate click; null when none/cleared.
  const [validateOk, setValidateOk] = useState<string | null>(null);
  const hostLimits = useHostLimits();

  // Subscribe to the overlaid run's SSE stream and fold each event into
  // the store so the canvas paints node status live. Re-subscribes when
  // a new run starts (overlay.runId changes); tears down on unmount.
  const overlayRunId = overlay?.runId ?? null;
  useEffect(() => {
    if (!overlayRunId) return;
    const sub = subscribeToRun(overlayRunId, {
      modes: ['updates'],
      // Relax the default 30s/120s timeouts — a watched run can be long
      // and idle between nodes; the idle timer still resets per event.
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 30 * 60_000,
      onEvent: (ev) => useBuilderStore.getState().applyRunEvent(ev),
    });
    return () => sub.close();
  }, [overlayRunId]);

  // Dry-run validation: the same gates Run applies — graph serialization
  // (empty graph / cycles / orphan edges via SerializeError), default-inputs
  // JSON parse, and the host-capability pre-flight — but with no network
  // work. Surfaces "build → run → cryptic failure" problems at author time.
  function onValidate() {
    setError(null);
    setPreflight(null);
    setValidateOk(null);
    const snap = useBuilderStore.getState().snapshot();
    try {
      serializeWithIdMap(snap);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const raw = snap.defaultInputs?.trim();
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        setError('Default inputs is not valid JSON.');
        return;
      }
    }
    const caps = collectPreflightIssues(snap.nodes);
    const limits = collectLimitIssues(snap.nodes, hostLimits);
    if (caps.length > 0 || limits.length > 0) {
      setPreflight({ caps, limits });
      return;
    }
    const nN = snap.nodes.length;
    const eN = snap.edges.length;
    setValidateOk(
      `Valid — ${nN} node${nN === 1 ? '' : 's'}, ${eN} edge${eN === 1 ? '' : 's'}. ` +
        `No cycles, default inputs parse, and the host can run every node.` +
        formatAdvertisedLimits(hostLimits),
    );
  }

  async function onRun(force = false) {
    setError(null);
    setValidateOk(null);
    const snap0 = useBuilderStore.getState().snapshot();
    // Pre-flight host-capability + engine-limit check before doing any
    // network work. The two are surfaced together so the user sees the
    // full set of author-time problems in one banner.
    if (!force) {
      const caps = collectPreflightIssues(snap0.nodes);
      const limits = collectLimitIssues(snap0.nodes, hostLimits);
      if (caps.length > 0 || limits.length > 0) {
        setPreflight({ caps, limits });
        return;
      }
    }
    setPreflight(null);
    setRunning(true);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const { definition: def, backendIdToBuilder } = serializeWithIdMap(snap);
      let inputs: Record<string, unknown> = {};
      const raw = snap.defaultInputs?.trim();
      if (raw) {
        try {
          inputs = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error('Default inputs is not valid JSON.');
        }
      }
      await registerWorkflow(def);
      // Omit body.tenantId so the BE infers from the authenticated
      // session/bearer (req.tenantId): `anon:<sid>` for cookie-anon
      // callers, `user:<hash>` for Firebase-signed-in callers. A
      // hardcoded 'demo' here is rejected by principalAuthorizer
      // for any non-bearer-with-demo-allowlist principal — that's
      // the "principal cannot operate under tenant demo" error.
      const res = await createRun({ workflowId: def.workflowId, inputs });
      // Stay on the canvas and paint the run live, rather than navigating
      // straight to the text event log. The banner offers a jump to the
      // full run detail for the timeline / reasoning / inspector views.
      useBuilderStore.getState().startOverlay(res.runId, backendIdToBuilder);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  }

  // Export the built graph as portable JSON (the SavedWorkflow shape —
  // open execution schema, RFC 0037 §1). Re-importable here or shareable.
  function onExport() {
    const snap = useBuilderStore.getState().snapshot();
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (snap.name || 'workflow').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    a.download = `${safe}.openwop-workflow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Export the built graph as an RFC 0013 workflow-chain-pack manifest
  // (the authoring half of "publish as a chain pack" — the user submits
  // it via the PR-based registry flow; the app never signs/pushes). Runs
  // the same graph validation as Run, so cycles/orphans surface here too.
  function onExportChainPack() {
    setError(null);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const manifest = buildChainPackManifest(snap);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = (snap.name || 'workflow').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
      a.download = `${safe}.workflow-chain-pack.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Publish-to-registry helper. Registry submission is a PR-based flow
  // per `PUBLISHING.md` + `spec/v1/registry-operations.md` — there's no
  // in-app push for trust + provenance reasons (Ed25519 signing happens
  // at PR-merge time by the registry maintainers, not in the browser).
  // This action materializes the manifest + opens a checklist with the
  // canonical GitHub registry directory URL so the operator can finish
  // the submission with one click into the registry.
  function onPublishToRegistry() {
    setError(null);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const manifest = buildChainPackManifest(snap);
      const manifestJson = JSON.stringify(manifest, null, 2);
      // Strip `community.local.` prefix from the manifest name to get
      // the final slug; the registry directory uses the bare slug as
      // the per-pack directory name (see existing entries under
      // `registry/packs/<slug>/`).
      const slug = manifest.name.replace(/^community\.local\./, '');
      setPublishHelp({ slug, size: manifestJson.length, manifestJson });
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Import portable JSON. Mints a fresh workflow id so importing never
  // clobbers the workflow currently open, then navigates into it.
  async function onImportFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const raw: unknown = JSON.parse(text);
      const id = newWorkflowId();
      const now = new Date().toISOString();
      let imported: SavedWorkflow;
      if (looksCanonical(raw)) {
        // Canonical WorkflowDefinition (an `examples/*` pipeline, a
        // chain-pack composition, or this builder's own chain-pack
        // export) — convert typeIds back to builder kinds.
        const { name, nodes, edges, defaultInputs } = fromCanonicalDefinition(raw);
        imported = {
          id,
          name: `${name} (imported)`,
          version: '1.0.0',
          nodes,
          edges,
          defaultInputs,
          createdAt: now,
          updatedAt: now,
        };
      } else {
        // Builder SavedWorkflow shape (this builder's "Export" output).
        const parsed = raw as Partial<SavedWorkflow>;
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('Not an OpenWOP workflow export (missing nodes/edges).');
        }
        imported = {
          id,
          name: parsed.name ? `${parsed.name} (imported)` : 'Imported workflow',
          version: parsed.version ?? '1.0.0',
          nodes: parsed.nodes,
          edges: parsed.edges,
          defaultInputs: parsed.defaultInputs ?? '{}',
          createdAt: now,
          updatedAt: now,
        };
      }
      useBuilderStore.getState().loadFromSaved(imported);
      useBuilderStore.getState().persist();
      nav(`/builder/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="builder-shell">
      <BuilderToolbar
        name={name}
        workflowId={workflowId}
        canUndo={canUndo}
        canRedo={canRedo}
        running={running}
        undo={undo}
        redo={redo}
        onExport={onExport}
        onExportChainPack={onExportChainPack}
        onPublishToRegistry={onPublishToRegistry}
        onImportFile={onImportFile}
        onNewWorkflow={onNewWorkflow}
        onValidate={onValidate}
        onRun={() => onRun()}
      />
      {error && <div className="alert error builder-toolbar-error">{error}</div>}
      {validateOk && (
        <div className="alert success builder-toolbar-error" role="status">
          <CheckIcon size={14} /> {validateOk}
        </div>
      )}
      {publishHelp && (
        <PublishHelpBanner publishHelp={publishHelp} onClose={() => setPublishHelp(null)} />
      )}
      {preflight && (
        <PreflightBanner
          preflight={preflight}
          onCancel={() => setPreflight(null)}
          onRunAnyway={() => onRun(true)}
        />
      )}
      {overlay && <RunOverlayBanner />}
      <div className="builder-body">
        <NodePalette />
        <BuilderCanvas />
        <Inspector />
      </div>
    </div>
  );
}
