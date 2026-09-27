/**
 * ADR 0475 — the builder debug-session actions (pin / unpin / prefill /
 * execute-from-step), shared by the Inspector's Debug section, the debug
 * banner, and BuilderShell's `?debugRun` deep-link handling.
 *
 * The store keeps pins keyed by BUILDER node id (the canvas/inspector space);
 * the server keeps them keyed by BACKEND node id. `serializeWithIdMap` is the
 * ONE translation (usually an identity map — ADR 0440 P1 preserves ids); when
 * the canvas is momentarily unserializable (a cycle mid-edit), the id maps
 * fall back to identity so pin STATE never becomes unreachable.
 */

import { useBuilderStore, type DebugSession } from './store/builderStore.js';
import { serializeWithIdMap, SerializeError } from './schema/serialize.js';
import { registerWorkflow } from './persistence/registerClient.js';
import { definitionMetadataFor } from './persistence/definitionMetadata.js';
import {
  listDebugPins,
  putDebugPin,
  deleteDebugPin,
  clearDebugPins,
  prefillPinsFromRun,
  startDebugRun,
  type DebugRunStart,
} from '../workflows/workflowDebugClient.js';

interface IdMaps {
  builderIdToBackend: Record<string, string>;
  backendIdToBuilder: Record<string, string>;
}

function idMaps(): IdMaps {
  const s = useBuilderStore.getState();
  try {
    const { builderIdToBackend, backendIdToBuilder } = serializeWithIdMap(s.snapshot());
    return { builderIdToBackend, backendIdToBuilder };
  } catch (err) {
    if (!(err instanceof SerializeError)) throw err;
    const identity = Object.fromEntries(s.nodes.map((n) => [n.id, n.id]));
    return { builderIdToBackend: identity, backendIdToBuilder: identity };
  }
}

/** Load the server-side pins into the store (the session's source of truth). */
export async function loadDebugSessionFromServer(workflowId: string, sourceRunId?: string): Promise<void> {
  const pins = await listDebugPins(workflowId);
  const { backendIdToBuilder } = idMaps();
  const session: DebugSession = { pins: {}, ...(sourceRunId ? { sourceRunId } : {}) };
  for (const p of pins) {
    const builderId = backendIdToBuilder[p.nodeId] ?? p.nodeId;
    session.pins[builderId] = {
      backendNodeId: p.nodeId,
      output: p.output,
      ...(p.sourceRunId ? { sourceRunId: p.sourceRunId } : {}),
    };
  }
  useBuilderStore.getState().setDebugSession(
    Object.keys(session.pins).length > 0 || session.sourceRunId ? session : null,
  );
}

/** Pin one node's output (server first, then the store — no optimistic lie). */
export async function pinNodeOutput(builderNodeId: string, output: Record<string, unknown>): Promise<void> {
  const s = useBuilderStore.getState();
  const backendNodeId = idMaps().builderIdToBackend[builderNodeId] ?? builderNodeId;
  await putDebugPin(s.workflowId, backendNodeId, output);
  s.setDebugPin(builderNodeId, { backendNodeId, output });
}

export async function unpinNode(builderNodeId: string): Promise<void> {
  const s = useBuilderStore.getState();
  const backendNodeId = s.debugSession?.pins[builderNodeId]?.backendNodeId
    ?? idMaps().builderIdToBackend[builderNodeId] ?? builderNodeId;
  await deleteDebugPin(s.workflowId, backendNodeId);
  s.removeDebugPin(builderNodeId);
}

/** End the debug session: clear the server pins AND the store state. */
export async function clearDebugSession(): Promise<void> {
  const s = useBuilderStore.getState();
  await clearDebugPins(s.workflowId);
  s.setDebugSession(null);
}

/** Failed-run→editor: prefill pins from the run's real outputs, then load the
 *  session. Returns the node ids the run had outputs for that no longer exist
 *  on the head (reported, never silently dropped — ADR 0475 OQ1). */
export async function prefillDebugSessionFromRun(workflowId: string, runId: string): Promise<{ pinned: string[]; unmatched?: string[] }> {
  const result = await prefillPinsFromRun(workflowId, runId);
  await loadDebugSessionFromServer(workflowId, runId);
  return result;
}

/** Execute-from-step: register the CURRENT canvas as the head (the same
 *  save-before-run discipline as the toolbar Run), start the debug run, and
 *  paint it through the existing overlay. Throws `MissingPinsError` (typed)
 *  when upstream pins are missing — callers surface the named nodes. */
export async function runFromNode(builderNodeId: string, mode: 'from-here' | 'only'): Promise<DebugRunStart> {
  const s = useBuilderStore.getState();
  const snap = s.snapshot();
  const { definition, builderIdToBackend, backendIdToBuilder } = serializeWithIdMap(snap);
  await registerWorkflow({ ...definition, metadata: definitionMetadataFor(snap) });
  let inputs: Record<string, unknown> | undefined;
  const raw = snap.defaultInputs?.trim();
  if (raw) {
    try { inputs = JSON.parse(raw) as Record<string, unknown>; } catch { inputs = undefined; }
  }
  const backendNodeId = builderIdToBackend[builderNodeId] ?? builderNodeId;
  const started = await startDebugRun(s.workflowId, backendNodeId, mode, inputs);
  useBuilderStore.getState().startOverlay(started.runId, backendIdToBuilder);
  return started;
}

/** Translate backend node ids (e.g. a 422's `missingPins`) into the display
 *  names the author sees on the canvas. */
export function nodeDisplayNames(backendNodeIds: string[]): string[] {
  const s = useBuilderStore.getState();
  const { backendIdToBuilder } = idMaps();
  return backendNodeIds.map((id) => {
    const builderId = backendIdToBuilder[id] ?? id;
    const node = s.nodes.find((n) => n.id === builderId);
    return node?.name?.trim() ? node.name : id;
  });
}
