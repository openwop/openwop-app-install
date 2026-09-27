/**
 * Canvas framework — the version-history modal (ADR 0310, extracted from the
 * app-builder's HistoryModal / ADR 0305 Phase E). Lists the host.canvas
 * snapshots newest-first, resolves `capturedBy` to a member name (the ADR 0261
 * discipline — never show a raw id when a name exists), computes a compact
 * client-side change summary vs the CURRENT document on demand (the type's
 * `summarizeVersions`, receiving the TYPE-namespace t), and restores
 * non-destructively (a new head version) behind the canonical confirm.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { Notice, StateCard } from '../ui/index.js';
import { confirm } from '../ui/confirm.js';
import { loadOrgMembers } from '../orgs/orgMembers.js';
import type { CanvasClient, CanvasVersionRow } from './canvasClient.js';
import { summaryEntries, summaryLines, type VersionSummary } from './versionSummary.js';

export function CanvasHistoryModal<Doc extends object>({ client, orgId, canvasId, currentDoc, coerceDoc, summarize, typeNamespace, onClose, onRestored }: {
  client: CanvasClient;
  orgId: string;
  canvasId: string;
  currentDoc: Doc;
  coerceDoc: (state: Record<string, unknown>) => Doc;
  summarize: ((snapshot: Doc, current: Doc, t: (k: string, o?: Record<string, unknown>) => string) => VersionSummary) | undefined;
  typeNamespace: string;
  onClose: () => void;
  onRestored: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation('canvas');
  const { t: tt } = useTranslation(typeNamespace);
  const [rows, setRows] = useState<CanvasVersionRow[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  /** The read FAILED — distinct from `null` (loading) and `[]` (genuinely none).
   *  #2596: the resolution depends on what the EMPTY state says; here it is
   *  a VERSION-HISTORY claim: "No versions captured yet" from a failed read. */
  const [rowsFailed, setRowsFailed] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, VersionSummary>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [versions, members] = await Promise.all([
          client.listVersions(orgId, canvasId),
          loadOrgMembers(orgId).catch(() => []),
        ]);
        if (!live) return;
        setRowsFailed(false);
        setRows(versions);
        setNames(new Map(members.filter((m) => m.subject).map((m) => [m.subject as string, m.displayName])));
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e.message : t('histLoadError'));
        setRowsFailed(true);
      }
    })();
    return () => { live = false; };
  }, [client, orgId, canvasId, t]);

  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.language]);

  const onCompare = async (row: CanvasVersionRow): Promise<void> => {
    if (!summarize) return;
    setBusy(row.versionId);
    try {
      const full = await client.getVersion(orgId, canvasId, row.versionId);
      setSummaries((s) => ({ ...s, [row.versionId]: summarize(coerceDoc(full.snapshot), currentDoc, (k, o) => tt(k, o ?? {})) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('histLoadError'));
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async (row: CanvasVersionRow): Promise<void> => {
    if (!(await confirm({ title: t('histRestoreTitle', { n: row.version }), body: t('histRestoreBody'), confirmLabel: t('histRestore') }))) return;
    setBusy(row.versionId);
    try {
      await client.restoreVersion(orgId, canvasId, row.versionId);
      onRestored();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('histRestoreFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal onClose={onClose} label={t('history')} showClose>
      <h2 className="cv-editor__panel-title">{t('history')}</h2>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {rows === null && rowsFailed ? (
        // NOT an empty list: "No versions captured yet" is a claim about this
        // canvas's SAVE HISTORY, made by a read that failed.
        <StateCard announce title={t('histLoadFailedTitle')} body={t('histLoadFailedBody')} />
      ) : rows === null ? <StateCard loading title={t('loading')} /> : rows.length === 0 ? (
        <p className="cv-editor__empty">{t('histEmpty')}</p>
      ) : (
        <ul className="cv-history">
          {rows.map((row) => (
            <li key={row.versionId} className="cv-history__row">
              <div className="cv-history__meta">
                <span className="cv-history__version">{t('version', { n: row.version })}</span>
                <span className="cv-history__when">{fmt.format(new Date(row.capturedAt))}</span>
                <span className="cv-history__who">{names.get(row.capturedBy) ?? t('histUnknownUser')}</span>
              </div>
              {summaries[row.versionId] ? (
                <ul className="cv-history__summary" role="status">
                  {summaryLines(summaries[row.versionId]!).map((line, i) => <li key={i}>{line}</li>)}
                  {/* ADR 0344 2d — structured entries: kind-tagged, path-titled. */}
                  {summaryEntries(summaries[row.versionId]!).map((e, i) => (
                    <li key={`e${i}`} className="cv-history__entry" title={e.path}>
                      <span className={`chip chip--muted cv-history__kind cv-history__kind--${e.kind}`}>{t(`diff_${e.kind}`)}</span> {e.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              <span className="action-bar">
                {!summaries[row.versionId] && summarize ? (
                  <Button variant="secondary" size="sm" disabled={busy === row.versionId} aria-busy={busy === row.versionId} onClick={() => void onCompare(row)}>
                    {busy === row.versionId ? t('loading') : t('histCompare')}
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" disabled={busy === row.versionId} onClick={() => void onRestore(row)}>{t('histRestore')}</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
