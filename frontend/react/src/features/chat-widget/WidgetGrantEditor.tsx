/**
 * ADR 0469 Phase B — the per-widget anon grant + caps editor.
 *
 * An operator authors the RFC 0132 anonymous-actor tool grant for ONE widget: which
 * tools an anonymous visitor may READ (tenant-scoped, no secrets) or WRITE (bounded,
 * HELD for human approval), the egress audiences, and the per-session/day/write caps.
 * The tool picker is populated from the WORKSPACE-SCOPED catalog SSoT (`getToolCatalog`)
 * — the same list `buildToolCatalog` backs, never a second copy.
 *
 * Honest-advertise (ADR 0469 review finding 1): this host wires the `hitl` write
 * control ONLY. `rate-limit-session-cap` is Phase D — NOT offered here, so an operator
 * can't configure a control whose turn-time semantics the backend doesn't yet honor.
 * Writes are therefore always held for approval; the UI states that plainly.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { getToolCatalog, patchWidget, type Widget, type WidgetAnonToolGrant, type WidgetCaps, type AnonWriteControl } from '../../client/chatWidgetClient.js';

interface Props {
  orgId: string;
  widget: Widget;
  onClose: () => void;
  onSaved: () => void;
}

/** A numeric cap field: empty ⇒ uncapped (undefined); a positive integer otherwise. */
function capValue(raw: string): number | undefined {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function WidgetGrantEditor({ orgId, widget, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation('chat-widget');
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [maxTurns, setMaxTurns] = useState(widget.caps.maxTurnsPerSession?.toString() ?? '');
  const [maxSessions, setMaxSessions] = useState(widget.caps.maxSessionsPerDay?.toString() ?? '');
  const [maxWrites, setMaxWrites] = useState(widget.caps.maxWritesPerDay?.toString() ?? '');
  const [read, setRead] = useState<Set<string>>(new Set(widget.anonToolGrant?.read ?? []));
  const [write, setWrite] = useState<Set<string>>(new Set(widget.anonToolGrant?.write ?? []));
  const [audiences, setAudiences] = useState((widget.anonToolGrant?.egressAudiences ?? []).join(', '));
  const [writeControl, setWriteControl] = useState<AnonWriteControl>(widget.anonToolGrant?.writeControl ?? 'hitl');
  const [maxAutoWrites, setMaxAutoWrites] = useState(widget.caps.maxAutoWritesPerSession?.toString() ?? '');
  // ADR 0470 OQ5 — visitor-facing disclosure config.
  const [businessName, setBusinessName] = useState(widget.businessName ?? '');
  const [privacyUrl, setPrivacyUrl] = useState(widget.privacyUrl ?? '');

  // Q1 — auto-run (`rate-limit-session-cap`) is only for a PURE tenant-write surface;
  // a surface that declares egress audiences keeps writes on the HITL review path so
  // no audience-unbound egress is ever auto-run. Reflect the backend rule in the UI.
  const egressDeclared = audiences.split(',').map((a) => a.trim()).filter(Boolean).length > 0;
  const effectiveControl: AnonWriteControl = egressDeclared ? 'hitl' : writeControl;

  useEffect(() => {
    void getToolCatalog(orgId).then(setCatalog).catch(() => setError(t('catalogError')));
  }, [orgId, t]);

  // Show every catalog tool + any already-granted id the catalog no longer lists (an
  // uninstalled pack), so a stale grant is visible + removable rather than silently lost.
  const tools = useMemo(() => {
    const all = new Set<string>(catalog ?? []);
    for (const id of read) all.add(id);
    for (const id of write) all.add(id);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [catalog, read, write]);

  const toggle = useCallback((set: Set<string>, setFn: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setFn(next);
  }, []);

  const onSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const grant: WidgetAnonToolGrant = {};
    if (read.size) grant.read = [...read];
    if (write.size) { grant.write = [...write]; grant.writeControl = effectiveControl; }
    const aud = audiences.split(',').map((a) => a.trim()).filter(Boolean);
    if (aud.length) grant.egressAudiences = aud;
    const caps: WidgetCaps = {};
    const mt = capValue(maxTurns); if (mt !== undefined) caps.maxTurnsPerSession = mt;
    const ms = capValue(maxSessions); if (ms !== undefined) caps.maxSessionsPerDay = ms;
    const mw = capValue(maxWrites); if (mw !== undefined) caps.maxWritesPerDay = mw;
    // The auto-run control REQUIRES its per-session bound (server enforces it too).
    const maw = capValue(maxAutoWrites);
    if (write.size && effectiveControl === 'rate-limit-session-cap') {
      if (maw === undefined) { setError(t('autoCapRequired')); setSaving(false); return; }
      caps.maxAutoWritesPerSession = maw;
    }
    try {
      await patchWidget(orgId, widget.widgetId, {
        caps,
        anonToolGrant: Object.keys(grant).length ? grant : null,
        businessName: businessName.trim() || null, // ADR 0470 OQ5 — null clears
        privacyUrl: privacyUrl.trim() || null,     // server rejects a non-http(s) URL
      });
      toast.success(t('grantSaved'));
      onSaved();
    } catch {
      setError(t('saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, read, write, audiences, maxTurns, maxSessions, maxWrites, maxAutoWrites, effectiveControl, businessName, privacyUrl, orgId, widget.widgetId, onSaved, t]);

  return (
    <section className="surface-card u-p-3 u-mt-2" aria-label={t('grantEditorAria', { agent: widget.agentId })}>
      <div className="u-flex u-items-center u-justify-between u-mb-1">
        <h2 tabIndex={-1} className="u-fs-12 u-fw-600">{t('grantEditorTitle', { agent: widget.agentId })}</h2>
        <Button variant="quiet" size="sm" onClick={onClose}>{t('common:close')}</Button>
      </div>
      <p className="muted u-fs-11 u-mb-2">{t('grantEditorHint')}</p>

      <fieldset className="u-mb-2">
        <legend className="field-label">{t('disclosureLegend')}</legend>
        <label className="field u-mb-1"><span className="field-label">{t('businessNameLabel')}</span>
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder={t('businessNamePlaceholder')} maxLength={80} />
        </label>
        <label className="field"><span className="field-label">{t('privacyUrlLabel')}</span>
          <input type="url" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder={t('privacyUrlPlaceholder')} />
          <span className="muted u-fs-11">{t('privacyUrlHint')}</span>
        </label>
      </fieldset>

      <fieldset className="u-mb-2">
        <legend className="field-label">{t('capsLegend')}</legend>
        <div className="u-flex u-gap-2 u-flex-wrap">
          <label className="field"><span className="field-label">{t('capTurns')}</span><input type="number" min={1} className="u-w-auto" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder={t('capUnlimited')} /></label>
          <label className="field"><span className="field-label">{t('capSessions')}</span><input type="number" min={1} className="u-w-auto" value={maxSessions} onChange={(e) => setMaxSessions(e.target.value)} placeholder={t('capUnlimited')} /></label>
          <label className="field"><span className="field-label">{t('capWrites')}</span><input type="number" min={1} className="u-w-auto" value={maxWrites} onChange={(e) => setMaxWrites(e.target.value)} placeholder={t('capUnlimited')} /></label>
        </div>
      </fieldset>

      <fieldset className="u-mb-2">
        <legend className="field-label">{t('toolsLegend')}</legend>
        {write.size > 0 && (
          <div className="u-mb-1">
            <span className="field-label">{t('controlLegend')}</span>
            <label className="u-flex u-gap-1 u-items-center u-fs-11">
              <input type="radio" name="writeControl" checked={effectiveControl === 'hitl'} disabled={egressDeclared} onChange={() => setWriteControl('hitl')} /> {t('controlHitl')}
            </label>
            <label className="u-flex u-gap-1 u-items-center u-fs-11">
              <input type="radio" name="writeControl" checked={effectiveControl === 'rate-limit-session-cap'} disabled={egressDeclared} onChange={() => setWriteControl('rate-limit-session-cap')} /> {t('controlAuto')}
            </label>
            {egressDeclared && <Notice variant="info">{t('controlEgressForcesHitl')}</Notice>}
            {effectiveControl === 'hitl' ? (
              <Notice variant="info">{t('writeHitlNote')}</Notice>
            ) : (
              <>
                <Notice variant="warning">{t('writeAutoNote')}</Notice>
                <label className="field u-mt-1"><span className="field-label">{t('autoCapLabel')}</span>
                  <input type="number" min={1} className="u-w-auto" value={maxAutoWrites} onChange={(e) => setMaxAutoWrites(e.target.value)} placeholder={t('autoCapPlaceholder')} />
                </label>
              </>
            )}
          </div>
        )}
        {catalog === null && !error ? (
          <p className="muted u-fs-11">{t('catalogLoading')}</p>
        ) : tools.length === 0 ? (
          <p className="muted u-fs-11">{t('catalogEmpty')}</p>
        ) : (
          <div role="table" aria-label={t('toolsLegend')} className="u-mt-1 u-maxh-14r u-overflow-y-auto">
            <div role="row" className="u-flex u-gap-2 u-fs-11 u-fw-600 u-mb-1">
              <span role="columnheader" className="u-w-4r">{t('colRead')}</span>
              <span role="columnheader" className="u-w-4r">{t('colWrite')}</span>
              <span role="columnheader">{t('colTool')}</span>
            </div>
            {tools.map((id) => (
              <div role="row" key={id} className="u-flex u-gap-2 u-items-center u-fs-11">
                <label className="u-w-4r u-flex u-gap-1 u-items-center">
                  <input type="checkbox" checked={read.has(id)} onChange={() => toggle(read, setRead, id)} aria-label={t('readAria', { tool: id })} />
                </label>
                <label className="u-w-4r u-flex u-gap-1 u-items-center">
                  <input type="checkbox" checked={write.has(id)} onChange={() => toggle(write, setWrite, id)} aria-label={t('writeAria', { tool: id })} />
                </label>
                <code className="u-fs-11">{id}</code>
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <label className="field u-mb-2"><span className="field-label">{t('audiencesLabel')}</span>
        <input value={audiences} onChange={(e) => setAudiences(e.target.value)} placeholder={t('audiencesPlaceholder')} />
        <span className="muted u-fs-11">{t('audiencesHint')}</span>
      </label>

      {error && <Notice variant="error">{error}</Notice>}
      <div className="u-flex u-gap-1 u-mt-2">
        <Button variant="primary" disabled={saving} onClick={() => void onSave()}>{t('grantSave')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('common:cancel')}</Button>
      </div>
    </section>
  );
}
