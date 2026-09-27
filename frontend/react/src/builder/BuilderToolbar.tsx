/**
 * Builder top bar — the §7.2.1 shell grammar on the SHARED `.cv-editor__bar`
 * vocabulary (CV-1: one bar stylesheet for every canvas editor). Zones:
 * identity (‹ back · name · id chip) · spacer · history pair · view cluster
 * (Share ▾ / New / Validate — folding into ONE ⋮ Menu ≤920px, CV-15) ·
 * Create with AI (clay-soft) · Run (the single clay-solid CTA). The former
 * `.builder-toolbar`/`.tb-*` chrome is deleted.
 */

import { Button } from '../ui/Button.js';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { UndoIcon, RedoIcon, SparklesIcon, ChevronDownIcon, PlusIcon, PlayIcon, ArrowLeftIcon, MoreHorizontalIcon, UsersIcon } from '../ui/icons/index.js';
import { InfoTip } from '../ui/InfoTip.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { useMediaQuery } from '../ui/useMediaQuery.js';

interface BuilderToolbarProps {
  /** ADR 0369 §5 — non-null while the canvas holds an unpromoted draft. */
  draft: { canSave: boolean } | null;
  onSaveDraft(): void;
  name: string;
  workflowId: string;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  aiOpen: boolean;
  /** ADR 0596 (`WFAU-5`) — the drawer restores focus HERE on close. */
  aiTriggerRef?: React.Ref<HTMLButtonElement>;
  undo(): void;
  redo(): void;
  onExport(): void;
  onOpenHistory(): void;
  onOpenEvals(): void;
  onExportChainPack(): void;
  onPublishToRegistry(): void;
  onImportFile(file: File): void;
  onNewWorkflow(): void;
  onValidate(): void;
  onRun(): void;
  onCreateWithAi(): void;
  /** ADR 0476 — pre-run cost hint ("~$0.02/run"); null hides it (fail-soft). */
  /** `unavailable` marks the READ-FAILED arm, which must not read as a price
   *  (UX-BLD-2) — it styles as a warning chip, never the muted cost chip. */
  runEstimate?: { label: string; title: string; unavailable?: boolean } | null;
  /** ADR 0476 — failure-heatmap toggle state + handler. */
  heatmapOn: boolean;
  onToggleHeatmap(): void;
  /** ADR 0482 §6 — cost-heatmap mode (latest terminal run's costByNode). */
  costHeatmapOn: boolean;
  onToggleCostHeatmap(): void;
  /** ADR 0474 correction (grade-ux #1) — non-null when this workflow is
   *  PUBLISHED and its head has moved past the published pin: production
   *  keeps running the old revision until this re-publish. */
  publish: { canPublish: boolean } | null;
  onPublishChanges(): void;
  /** ADR 0481 — non-null only when the workflow-collab probe answered (both
   *  toggles on + eligible workflow); null hides the affordance silently. */
  collab: { status: 'off' | 'connecting' | 'live' | 'reconnecting' | 'failed'; peerCount: number; peerNames: string } | null;
  onToggleCollab(): void;
}

export function BuilderToolbar({
  name, workflowId, canUndo, canRedo, running, aiOpen, aiTriggerRef, draft, onSaveDraft,
  undo, redo, onExport, onOpenHistory, onExportChainPack, onPublishToRegistry, onImportFile,
  onNewWorkflow, onValidate, onRun, onCreateWithAi, runEstimate, heatmapOn, onToggleHeatmap, onOpenEvals,
  costHeatmapOn, onToggleCostHeatmap,
  publish, onPublishChanges, collab, onToggleCollab,
}: BuilderToolbarProps) {
  const { t } = useTranslation('builder');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const narrowBar = useMediaQuery('(max-width: 920px)');

  // Share ▾ — collapses Export / Export chain pack / Publish / Import into the
  // shared accessible Menu primitive (DS-8: roving focus + focus return).
  const shareItems: MenuEntry[] = [
    // ADR 0474 — revision history lives beside the other whole-workflow verbs.
    { id: 'history', label: t('historyMenu'), title: t('historyMenuTitle'), onSelect: onOpenHistory },
    // ADR 0477 — the workflow's evaluation suites.
    { id: 'evals', label: t('evalsMenu'), title: t('evalsMenuTitle'), onSelect: onOpenEvals },
    // ADR 0476 — the canvas failure-hotspot view (per-node fail counts).
    { id: 'heatmap', label: heatmapOn ? t('heatmapMenuOff') : t('heatmapMenuOn'), title: t('heatmapMenuTitle'), onSelect: onToggleHeatmap },
    // ADR 0482 §6 — the canvas cost view (latest terminal run's per-node USD).
    { id: 'cost-heatmap', label: costHeatmapOn ? t('costHeatmapMenuOff') : t('costHeatmapMenuOn'), title: t('costHeatmapMenuTitle'), onSelect: onToggleCostHeatmap },
    { id: 'sep-history', separator: true },
    { id: 'export', label: t('export'), title: t('exportTitle'), onSelect: onExport },
    { id: 'export-chain', label: t('exportChainPack'), title: t('exportChainPackTitle'), onSelect: onExportChainPack },
    { id: 'publish', label: t('publishToRegistry'), title: t('publishToRegistryTitle'), onSelect: onPublishToRegistry },
    { id: 'sep', separator: true },
    { id: 'import', label: t('import'), title: t('importTitle'), onSelect: () => importInputRef.current?.click() },
  ];

  return (
    <div className="cv-editor__bar builder-bar">
      {/* Identity */}
      <Link to="/builder" className="btn-ghost btn-sm" title={t('backToWorkflowsTitle')} aria-label={t('backToWorkflowsTitle')}>
        <ArrowLeftIcon size={15} aria-hidden />
      </Link>
      <input
        className="cv-editor__name"
        value={name}
        onChange={(e) => useBuilderStore.getState().setName(e.target.value)}
        placeholder={t('workflowNamePlaceholder')}
        aria-label={t('workflowNamePlaceholder')}
      />
      <span className="cv-editor__status builder-id-chip" title={t('workflowIdTitle')}>{workflowId || newWorkflowId()}</span>

      <span className="cv-editor__spacer" />

      {/* History pair (the ⌘Z twins live in the shell's shortcut registry, CV-2). */}
      <span className="cv-editor__tools" role="group" aria-label={t('historyGroup')}>
        <Button variant="quiet" size="sm" onClick={undo} disabled={!canUndo} title={t('undo')} aria-label={t('undo')}><UndoIcon size={15} aria-hidden /></Button>
        <Button variant="quiet" size="sm" onClick={redo} disabled={!canRedo} title={t('redo')} aria-label={t('redo')}><RedoIcon size={15} aria-hidden /></Button>
      </span>
      <span className="cv-editor__bar-sep" aria-hidden="true" />

      {/* View cluster — folds into ONE ⋮ overflow under 920px (§7.2.1/CV-15). */}
      {narrowBar ? (
        <Menu
          label={t('moreActions')}
          triggerContent={<MoreHorizontalIcon size={15} aria-hidden />}
          triggerClassName="btn-ghost btn-sm"
          triggerTitle={t('moreActions')}
          items={[
            ...shareItems,
            { id: 'sep2', separator: true },
            { id: 'new', label: t('new'), onSelect: onNewWorkflow },
            { id: 'validate', label: t('validate'), title: t('validateTitle'), disabled: running, onSelect: onValidate },
          ]}
          portal
        />
      ) : (
        <>
          <Menu
            label={t('workflowMenu')}
            triggerClassName="secondary btn-sm"
            triggerContent={<>{t('workflowMenu')} <ChevronDownIcon size={13} /></>}
            items={shareItems}
          />
          <Button variant="secondary" size="sm" onClick={onNewWorkflow}><PlusIcon size={14} aria-hidden /> {t('new')}</Button>
          <Button variant="secondary" size="sm" onClick={onValidate} disabled={running} title={t('validateTitle')}>
            {t('validate')}
          </Button>
        </>
      )}
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
      <span className="cv-editor__bar-sep" aria-hidden="true" />

      {/* ADR 0481 — the multiplayer session toggle + live/peer chip. Rendered
          only when the probe said the workflow-collab feature answers for this
          tenant + workflow (a 404 hides the whole cluster silently). */}
      {collab ? (
        <>
          {/* ux-H2 — a label-swapping ACTION PAIR (Go live ⇄ Leave session),
              not a toggle: no aria-pressed (AT would read "Leave session,
              pressed", pairing a pressed state with the wrong verb). */}
          <Button
            variant={collab.status === 'off' ? 'secondary' : 'accent'} size="sm"
            onClick={onToggleCollab}
            title={collab.status === 'off' ? t('collabGoLiveTitle') : t('collabLeaveTitle')}
          >
            <UsersIcon size={14} aria-hidden /> {collab.status === 'off' ? t('collabGoLive') : t('collabLeave')}
          </Button>
          {/* No role="status" (ux-M5): state TRANSITIONS announce once each via
              the shell's sr-only region; a live-region chip re-announced on
              every re-render. 'failed' wears the warning register (ux-M3) with
              SHORT chip text — the full guidance moves to the title. */}
          {collab.status !== 'off' ? (() => {
            const chipText = collab.status === 'live'
              ? (collab.peerCount > 0 ? t('collabLiveWithPeers', { count: collab.peerCount }) : t('collabLiveSolo'))
              : collab.status === 'connecting' ? t('collabConnecting')
              : collab.status === 'reconnecting' ? t('collabReconnecting')
              : t('collabFailedShort');
            // ux-M2 — the accessible name carries WHO is here, not just how
            // many; 'failed' names the full guidance the short chip dropped.
            const chipAria = collab.status === 'live'
              ? (collab.peerCount > 0
                ? t('collabPeersAria', { count: collab.peerCount, names: collab.peerNames })
                : t('collabPeersAriaSolo'))
              : collab.status === 'failed' ? t('collabFailed') : chipText;
            return (
              <span
                className={`chip${collab.status === 'live' ? '' : collab.status === 'failed' ? ' chip--warning' : ' chip--muted'} cv-presence__live builder-collab-chip`}
                role="img"
                aria-label={chipAria}
                title={collab.status === 'failed' ? t('collabFailed') : (collab.peerNames || undefined)}
              >
                <span className={`cv-presence__dot${collab.status === 'live' ? '' : ' cv-presence__dot--off'}`} aria-hidden="true" />
                {chipText}
              </span>
            );
          })() : null}
        </>
      ) : null}

      {/* ADR 0596 (`WFAU-5`) — a DISCLOSURE, not a toggle button: it controls a
          separate region, so `aria-expanded` + `aria-controls` is the correct
          pairing. `aria-pressed` described a two-state button and told AT
          nothing about the drawer it governs. */}
      <Button
        variant="accent" size="sm"
        onClick={onCreateWithAi}
        {...(aiTriggerRef ? { ref: aiTriggerRef } : {})}
        aria-expanded={aiOpen}
        aria-controls="builder-ai-drawer"
        title={t('createWithAiTitle')}
      >
        <SparklesIcon size={14} aria-hidden /> {t('createWithAi')}
      </Button>

      {publish ? (
        <Button
          variant="accent" size="sm"
          onClick={onPublishChanges}
          disabled={running || !publish.canPublish}
          title={t('publishChangesTitle')}
        >
          {t('publishChanges')}
        </Button>
      ) : null}
      {draft ? (
        <>
          <span className="chip chip--muted">{t('draftChip')}</span>
          <Button
            variant="accent" size="sm"
            onClick={onSaveDraft}
            disabled={running || !draft.canSave}
            title={draft.canSave ? t('saveDraftTitle') : t('saveDraftLockedTitle')}
          >
            {t('saveDraft')}
          </Button>
        </>
      ) : null}
      {runEstimate ? (
        <InfoTip label={t('runEstimateTipAria')} text={runEstimate.title}>
          <span className={runEstimate.unavailable ? 'chip chip--warning u-fs-10' : 'chip chip--muted u-fs-10'}>
            {runEstimate.label}
          </span>
        </InfoTip>
      ) : null}
      {/* ADR 0476 (ux-9) — the honest-window disclosure while failure heat is
          lit: badges count the recent-runs window, not all time. InfoTip so
          the disclosure reaches keyboard/SR users (ux-5). */}
      {heatmapOn ? (
        <InfoTip label={t('failureHeatChipTipAria')} text={t('failureHeatChipTitle')}>
          <span className="chip chip--muted u-fs-10">{t('failureHeatChip')}</span>
        </InfoTip>
      ) : null}
      {/* ADR 0482 §6 — the honest-window disclosure while cost heat is lit:
          the badges show ONE run's money (the latest terminal), not a trend.
          Muted register (ux-3): cost is a data dimension, not a warning. */}
      {costHeatmapOn ? (
        <InfoTip label={t('costHeatChipTipAria')} text={t('costHeatChipTitle')}>
          <span className="chip chip--muted u-fs-10">{t('costHeatChip')}</span>
        </InfoTip>
      ) : null}
      <Button variant="accent-solid" size="sm" onClick={onRun} disabled={running}>
        <PlayIcon size={14} aria-hidden /> {running ? t('running') : t('run')}
      </Button>
    </div>
  );
}
