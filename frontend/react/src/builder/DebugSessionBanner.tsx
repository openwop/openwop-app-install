/**
 * ADR 0475 — the debug-session banner. Visible whenever the builder holds
 * pinned node outputs: the author must always be able to SEE that pins exist
 * (a pin silently satisfying an upstream node is the dishonest failure mode
 * this feature is designed against). Links the source run when the session
 * came from one (failed-run→editor), counts the pins, and offers the one
 * session-level verb: clear.
 */

import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from './store/builderStore.js';
import { clearDebugSession } from './debugSession.js';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';

export function DebugSessionBanner(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const session = useBuilderStore((s) => s.debugSession);
  const [busy, setBusy] = useState(false);

  const pinCount = session ? Object.keys(session.pins).length : 0;
  if (!session || (pinCount === 0 && !session.sourceRunId)) return null;

  async function onClear(): Promise<void> {
    setBusy(true);
    try {
      await clearDebugSession();
    } catch {
      // Assertive failure register (ux-review L2) — the banner itself is a
      // polite info region, wrong for an async-action failure.
      toast.error(t('debugSessionClearFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice variant="info">
      <span className="u-flex u-items-center u-gap-2 u-wrap">
        <strong>{t('debugSessionTitle')}</strong>
        <span className="u-fs-13">{t('debugSessionPins', { count: pinCount })}</span>
        {session.sourceRunId ? (
          <Link className="inline-link u-fs-13" to={`/runs/${encodeURIComponent(session.sourceRunId)}`}>
            {t('debugSessionSourceRun')}
          </Link>
        ) : null}
        <Button variant="secondary" onClick={() => { void onClear(); }} disabled={busy}>
          {t('debugSessionClear')}
        </Button>
      </span>
    </Notice>
  );
}
