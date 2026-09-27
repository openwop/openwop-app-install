/**
 * ADR 0478 §1 — the tenant SLA-ladder editor (lazy-loaded by ReviewInboxPanel:
 * the inbox rides the entry chunk and the 200 kB budget is at the line).
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSlaPolicy, putSlaPolicy } from '../../notifications/approvalDeliveryClient.js';

/** ADR 0478 §1 — a compact SLA-ladder editor (minutes in the UI, ms on the
 *  wire; empty rung = off). Server-side validation is authoritative and its
 *  messages name the offending rung. */
export function SlaPolicySection(): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [remind, setRemind] = useState('');
  const [escalate, setEscalate] = useState('');
  const [expire, setExpire] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'load-error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Grade-ux #2 — retry via a reload counter: the previous
  // `setOpen(false); setOpen(true)` pair batches into a no-op state change,
  // so the [open] effect never re-fired and the button did nothing.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState('loading');
    getSlaPolicy()
      .then((p) => {
        if (!live) return;
        setEnabled(p.enabled);
        setRemind(p.remindAfterMs ? String(Math.round(p.remindAfterMs / 60000)) : '');
        setEscalate(p.escalateAfterMs ? String(Math.round(p.escalateAfterMs / 60000)) : '');
        setExpire(p.expireAfterMs ? String(Math.round(p.expireAfterMs / 60000)) : '');
        setState('idle');
      })
      // ux-review H2 — a failed load must NOT render a live form over
      // defaults (Save would overwrite the real tenant policy with them).
      .catch(() => { if (live) { setError(t('slaLoadFailed')); setState('load-error'); } });
    return () => { live = false; };
  }, [open, reload, t]);

  async function save(): Promise<void> {
    setState('saving');
    setError(null);
    const ms = (v: string): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 60000) : undefined;
    };
    try {
      const remindMs = ms(remind);
      const escalateMs = ms(escalate);
      const expireMs = ms(expire);
      await putSlaPolicy({
        enabled,
        ...(remindMs !== undefined ? { remindAfterMs: remindMs } : {}),
        ...(escalateMs !== undefined ? { escalateAfterMs: escalateMs } : {}),
        ...(expireMs !== undefined ? { expireAfterMs: expireMs } : {}),
      });
      setState('saved');
      // ux-review M4 — "0" silently turned a rung off while the field kept
      // showing 0; reflect the truth back into the inputs.
      if (ms(remind) === undefined) setRemind('');
      if (ms(escalate) === undefined) setEscalate('');
      if (ms(expire) === undefined) setExpire('');
    } catch (err) {
      // Grade-ux #8 — a 403 means "you need a workspace admin", and retrying
      // will never help; name the requirement instead of a generic failure.
      const msg = err instanceof Error ? err.message : '';
      if (/_403$|forbidden/i.test(msg)) setError(t('slaSaveForbidden'));
      else setError(err instanceof Error && !/_\d+$/.test(msg) ? msg : t('slaSaveFailed'));
      setState('idle');
    }
  }

  return (
    <details className="u-fs-12 u-pad-2" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="muted u-fs-11 u-cursor-pointer">{t('slaSectionTitle')}</summary>
      <p className="muted u-fs-11 u-m-0">{t('slaSectionBody')}</p>
      {state === 'loading' ? <p className="muted u-fs-11">{t('slaLoading')}</p>
        : state === 'load-error' ? (
          <Button variant="secondary" size="sm" className="u-mt-2" onClick={() => { setError(null); setReload((n) => n + 1); }}>
            {t('slaLoadRetry')}
          </Button>
        ) : (
        <div className="u-flex u-flex-col u-gap-2 u-mt-2">
          <label className="u-flex u-items-center u-gap-1">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('slaEnable')}
          </label>
          <label className="u-flex u-items-center u-gap-1">
            {t('slaRemindAfter')}
            <input type="number" min={1} className="ui-input slapolicy-minutes" value={remind} onChange={(e) => { setRemind(e.target.value); if (state === 'saved') setState('idle'); }} aria-label={t('slaRemindAfter')} />
          </label>
          <label className="u-flex u-items-center u-gap-1">
            {t('slaEscalateAfter')}
            <input type="number" min={1} className="ui-input slapolicy-minutes" value={escalate} onChange={(e) => { setEscalate(e.target.value); if (state === 'saved') setState('idle'); }} aria-label={t('slaEscalateAfter')} />
          </label>
          <label className="u-flex u-items-center u-gap-1">
            {t('slaExpireAfter')}
            <input type="number" min={1} className="ui-input slapolicy-minutes" value={expire} onChange={(e) => { setExpire(e.target.value); if (state === 'saved') setState('idle'); }} aria-label={t('slaExpireAfter')} />
          </label>
          <div className="u-flex u-items-center u-gap-2">
            <Button variant="secondary" size="sm" onClick={() => { void save(); }} disabled={state === 'saving'}>
              {t('slaSave')}
            </Button>
            {state === 'saved' ? <span className="muted u-fs-11" role="status">{t('slaSaved')}</span> : null}
          </div>
        </div>
      )}
      {error ? <p className="alert error u-fs-11 u-m-0" role="alert">{error}</p> : null}
    </details>
  );
}
