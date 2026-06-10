/**
 * Builder top toolbar: ‹ Workflows back-link, name input, undo/redo,
 * export / chain-pack / publish / import / new / validate / run actions.
 * Extracted from BuilderShell.tsx (pure extraction — no behavior change).
 */

import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { UndoIcon, RedoIcon } from '../ui/icons/index.js';

interface BuilderToolbarProps {
  name: string;
  workflowId: string;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  undo(): void;
  redo(): void;
  onExport(): void;
  onExportChainPack(): void;
  onPublishToRegistry(): void;
  onImportFile(file: File): void;
  onNewWorkflow(): void;
  onValidate(): void;
  onRun(): void;
}

export function BuilderToolbar({
  name,
  workflowId,
  canUndo,
  canRedo,
  running,
  undo,
  redo,
  onExport,
  onExportChainPack,
  onPublishToRegistry,
  onImportFile,
  onNewWorkflow,
  onValidate,
  onRun,
}: BuilderToolbarProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="builder-toolbar">
      <Link to="/builder" className="builder-toolbar-back" title="Back to workflows">
        ‹ Workflows
      </Link>
      <input
        className="builder-toolbar-name"
        value={name}
        onChange={(e) => useBuilderStore.getState().setName(e.target.value)}
        placeholder="Workflow name"
      />
      <span className="builder-toolbar-id muted">{workflowId || newWorkflowId()}</span>
      <div className="builder-toolbar-spacer" />
      <button className="secondary" onClick={undo} disabled={!canUndo} title="Undo" aria-label="Undo"><UndoIcon size={14} /></button>
      <button className="secondary" onClick={redo} disabled={!canRedo} title="Redo" aria-label="Redo"><RedoIcon size={14} /></button>
      <button className="secondary" onClick={onExport} title="Export this workflow as portable JSON">Export</button>
      <button
        className="secondary"
        onClick={onExportChainPack}
        title="Export as an RFC 0013 workflow-chain-pack manifest (submit via the registry PR flow)"
      >
        Export chain pack
      </button>
      <button
        className="secondary"
        onClick={onPublishToRegistry}
        title="Publish this workflow as a chain pack on packs.openwop.dev (walks through the PR-based submission flow)"
      >
        Publish to registry…
      </button>
      <button
        className="secondary"
        onClick={() => importInputRef.current?.click()}
        title="Import a workflow from JSON (opens as a new workflow)"
      >
        Import
      </button>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="u-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportFile(file);
          e.target.value = '';
        }}
      />
      <button className="secondary" onClick={onNewWorkflow}>New</button>
      <button
        className="secondary"
        onClick={onValidate}
        disabled={running}
        title="Check the workflow for cycles, invalid inputs, and missing host capabilities — without running it"
      >
        Validate
      </button>
      <button onClick={onRun} disabled={running}>
        {running ? 'Running…' : 'Run'}
      </button>
    </div>
  );
}
