/**
 * ADR 0475 — the Inspector's Debug section for a single selected node:
 * view/edit/remove the node's pinned output, and execute-from-step ("run from
 * here" / "only this node"). A missing-pin refusal (the route's 422) is
 * surfaced by NAME — the error tells the author exactly which upstream nodes
 * to pin next (the bulletproof bar: every error names the next action).
 */

import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { pinNodeOutput, unpinNode, runFromNode, nodeDisplayNames } from '../debugSession.js';
import { MissingPinsError } from '../../workflows/workflowDebugClient.js';

export function NodeDebugSection({ nodeId }: { nodeId: string }): JSX.Element {
  const { t } = useTranslation('builder');
  const pin = useBuilderStore((s) => s.debugSession?.pins[nodeId] ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ux-review H4/H5 — never surface a raw wire code ('pin_put_404'): map the
  // status suffix to a localized message that names the next action. The 404
  // case is concretely "this draft was never saved/run" (owner-gated routes
  // 404 an unregistered workflow), so say that.
  function localizeError(err: unknown): string {
    if (err instanceof MissingPinsError) {
      return t('debugMissingPins', { nodes: nodeDisplayNames(err.missingPins).join(', ') });
    }
    const code = err instanceof Error ? err.message : String(err);
    if (/_404$/.test(code)) return t('debugErrSaveFirst');
    if (/_429$/.test(code)) return t('debugErrRateLimited');
    if (/_4\d\d$/.test(code)) return t('debugErrRejected');
    return t('debugErrGeneric');
  }

  async function guard(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(localizeError(err));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(): void {
    setDraft(pin ? JSON.stringify(pin.output, null, 2) : '{\n  \n}');
    setEditing(true);
    setError(null);
  }

  async function savePin(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError(t('debugPinInvalidJson'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('debugPinInvalidJson'));
      return;
    }
    await guard(async () => {
      await pinNodeOutput(nodeId, parsed as Record<string, unknown>);
      setEditing(false);
    });
  }

  return (
    <>
      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('debugSection')}</div>

      {pin && !editing ? (
        <>
          <div className="builder-inspector-section-label u-fs-11">{t('debugPinnedOutput')}</div>
          <pre className="binspector-debug-pin-json u-fs-11">
            {JSON.stringify(pin.output, null, 2)}
          </pre>
        </>
      ) : null}

      {editing ? (
        <>
          <textarea
            className="binspector-debug-pin-editor"
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('debugPinEditorLabel')}
            spellCheck={false}
          />
          <div className="u-flex u-gap-2 u-mt-4">
            <Button variant="secondary" onClick={() => { void savePin(); }} disabled={busy}>
              {t('debugPinSave')}
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)} disabled={busy}>
              {t('common:cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className="u-flex u-gap-2 u-mt-4 u-wrap">
          <Button variant="secondary" onClick={beginEdit} disabled={busy}>
            {pin ? t('debugPinEdit') : t('debugPinAdd')}
          </Button>
          {pin ? (
            <Button variant="quiet" onClick={() => { void guard(() => unpinNode(nodeId)); }} disabled={busy}>
              {t('debugPinRemove')}
            </Button>
          ) : null}
        </div>
      )}

      <div className="u-flex u-gap-2 u-mt-4 u-wrap">
        <Button
          variant="secondary"
          onClick={() => { void guard(async () => { await runFromNode(nodeId, 'from-here'); }); }}
          disabled={busy}
          title={t('debugRunFromHereTitle')}
        >
          {t('debugRunFromHere')}
        </Button>
        <Button
          variant="quiet"
          onClick={() => { void guard(async () => { await runFromNode(nodeId, 'only'); }); }}
          disabled={busy}
          title={t('debugRunOnlyTitle')}
        >
          {t('debugRunOnly')}
        </Button>
      </div>

      {error ? (
        <div role="alert" className="alert error u-mt-4 u-fs-13">{error}</div>
      ) : null}
    </>
  );
}
