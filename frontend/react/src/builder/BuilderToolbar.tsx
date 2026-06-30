/**
 * Builder top toolbar — three zones (ADR 0073 §builder-UX): an IDENTITY zone
 * (‹ Workflows · name-as-title · id chip), a HISTORY pair (undo/redo), and a
 * right-aligned ACTION cluster. The four export/share actions collapse into one
 * `Share ▾` menu; `Run` is the single accent CTA, `Create with AI` a clay-soft
 * secondary, `Validate` an outline secondary. Token-only; buttons never wrap.
 */

import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { UndoIcon, RedoIcon, SparklesIcon, ChevronDownIcon, PlusIcon, PlayIcon } from '../ui/icons/index.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';

interface BuilderToolbarProps {
  name: string;
  workflowId: string;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  aiOpen: boolean;
  undo(): void;
  redo(): void;
  onExport(): void;
  onExportChainPack(): void;
  onPublishToRegistry(): void;
  onImportFile(file: File): void;
  onNewWorkflow(): void;
  onValidate(): void;
  onRun(): void;
  onCreateWithAi(): void;
}

export function BuilderToolbar({
  name, workflowId, canUndo, canRedo, running, aiOpen,
  undo, redo, onExport, onExportChainPack, onPublishToRegistry, onImportFile,
  onNewWorkflow, onValidate, onRun, onCreateWithAi,
}: BuilderToolbarProps) {
  const { t } = useTranslation('builder');
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Share ▾ — collapses Export / Export chain pack / Publish / Import into the
  // shared accessible Menu primitive (DS-8: roving focus + focus return).
  const shareItems: MenuEntry[] = [
    { id: 'export', label: t('export'), title: t('exportTitle'), onSelect: onExport },
    { id: 'export-chain', label: t('exportChainPack'), title: t('exportChainPackTitle'), onSelect: onExportChainPack },
    { id: 'publish', label: t('publishToRegistry'), title: t('publishToRegistryTitle'), onSelect: onPublishToRegistry },
    { id: 'sep', separator: true },
    { id: 'import', label: t('import'), title: t('importTitle'), onSelect: () => importInputRef.current?.click() },
  ];

  return (
    <div className="builder-toolbar">
      {/* Identity */}
      <Link to="/builder" className="builder-toolbar-back" title={t('backToWorkflowsTitle')}>
        {t('backToWorkflows')}
      </Link>
      <input
        className="builder-toolbar-name"
        value={name}
        onChange={(e) => useBuilderStore.getState().setName(e.target.value)}
        placeholder={t('workflowNamePlaceholder')}
        aria-label={t('workflowNamePlaceholder')}
      />
      <span className="builder-id-chip" title={t('workflowIdTitle')}>{workflowId || newWorkflowId()}</span>

      <div className="builder-toolbar-spacer" />

      {/* History */}
      <div className="tb-group" role="group" aria-label={t('historyGroup')}>
        <button className="tb-icon-btn" onClick={undo} disabled={!canUndo} title={t('undo')} aria-label={t('undo')}><UndoIcon size={15} /></button>
        <button className="tb-icon-btn" onClick={redo} disabled={!canRedo} title={t('redo')} aria-label={t('redo')}><RedoIcon size={15} /></button>
      </div>

      {/* Share ▾ — collapses Export / Export chain pack / Publish / Import */}
      <Menu
        label={t('share')}
        triggerClassName="secondary tb-btn"
        triggerContent={<>{t('share')} <ChevronDownIcon size={13} /></>}
        items={shareItems}
      />
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

      <button className="secondary tb-btn" onClick={onNewWorkflow}><PlusIcon size={14} /> {t('new')}</button>

      <button
        className="btn-accent tb-btn"
        onClick={onCreateWithAi}
        aria-pressed={aiOpen}
        title={t('createWithAiTitle')}
      >
        <SparklesIcon size={14} /> {t('createWithAi')}
      </button>

      <button className="secondary tb-btn" onClick={onValidate} disabled={running} title={t('validateTitle')}>
        {t('validate')}
      </button>

      <button className="btn-accent-solid tb-btn" onClick={onRun} disabled={running}>
        <PlayIcon size={14} /> {running ? t('running') : t('run')}
      </button>
    </div>
  );
}
