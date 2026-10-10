/**
 * ADR 0493 — the isolation self-test: turn `/ui-plugins`' four prose claims into
 * machine-checked results where that is honestly possible.
 *
 * The page has always listed four falsifiable legs — isolated · egress-denied ·
 * allowlist-bound · no-BYOK — as PROSE beside a mounted plugin, with nothing
 * verifying any of them. #2559 made the page stop *hiding* when the witness
 * couldn't mount. This makes the witness actually witness.
 *
 * TWO DESIGN CHOICES THAT MATTER MORE THAN THE CODE:
 *
 * 1. **The probe does NOT run inside the real plugin document.** Injecting probe
 *    script into a downloaded, untrusted plugin's document would mean editing a
 *    security-critical mount to test it — changing the thing under test. Instead
 *    this mounts its OWN first-party probe document, delivered the way a plugin
 *    frame is (ADR 0840): the host serves it with the same Content-Security-Policy
 *    header builder, and it is mounted by `src` under the same exported
 *    `PLUGIN_SANDBOX`. Weaken the header or the attribute and this goes red, and
 *    because the probe travels the real path, a proxy that strips or replaces the
 *    header turns it red too.
 *
 * 2. **`no-BYOK` is NOT probed, and is not given a tick.** It is the ABSENCE of a
 *    credential-bearing method from a closed allowlist — a property of the schema,
 *    not something a probe can demonstrate. A green checkmark there would be
 *    decorative, and four ticks where one is decorative is worse than the prose we
 *    had: it is precisely the "asserting what you did not verify" defect this whole
 *    programme has been closing. It renders as ASSERTED, visually distinct from a
 *    PASS, with the reason.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, AlertIcon, ShieldIcon } from '../../ui/icons/index.js';
import { PLUGIN_SANDBOX, makePluginMessageHandler } from './PluginFrame.js';
import { isolationProbeUrl, type ServedPlugin } from './pluginClient.js';

export type LegOutcome = 'pass' | 'fail' | 'running' | 'asserted' | 'inconclusive';

export interface LegResult {
  id: 'isolated' | 'egress' | 'allowlist' | 'nobyok';
  outcome: LegOutcome;
  /** The observed value, shown verbatim so a reader can judge it themselves. */
  detail?: string;
}


/** How long to wait for the framed probe before calling a leg inconclusive. A
 *  timeout is NOT a pass — an unanswered probe proves nothing either way. */
const PROBE_TIMEOUT_MS = 4000;

export function IsolationSelfTest({ plugin }: { plugin: ServedPlugin | undefined }): JSX.Element {
  const { t } = useTranslation('ui-plugins');
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [results, setResults] = useState<Record<string, LegResult>>({});
  const [ran, setRan] = useState(false);

  const set = useCallback((r: LegResult) => setResults((prev) => ({ ...prev, [r.id]: r })), []);

  /** Leg 3 — ALLOWLIST-BOUND. Runs the REAL `makePluginMessageHandler`, i.e. the
   *  same function the live frame's channel uses, against a plugin whose declared
   *  hostApi does NOT contain the probed method. A pass means the host refused
   *  before contacting the backend — `forward` throwing is the proof it was never
   *  called. */
  const runAllowlistLeg = useCallback(async () => {
    let forwarded = false;
    const responses: unknown[] = [];
    const handler = makePluginMessageHandler(
      { ...(plugin ?? ({} as ServedPlugin)), hostApi: ['artifact.read'] } as ServedPlugin,
      (m) => responses.push(m),
      async () => { forwarded = true; return {}; },
    );
    await handler({ openwop: 'ui-plugin/1', id: 1, type: 'request', method: 'openwop.probe.undeclared' });
    const res = responses[0] as { ok?: boolean; error?: { code?: string } } | undefined;
    const refused = res?.ok === false && res.error?.code === 'method_not_allowed';
    set({
      id: 'allowlist',
      outcome: refused && !forwarded ? 'pass' : 'fail',
      detail: forwarded ? t('legForwarded') : (res?.error?.code ?? t('legNoResponse')),
    });
  }, [plugin, set, t]);

  const run = useCallback(() => {
    setRan(true);
    setResults({
      isolated: { id: 'isolated', outcome: 'running' },
      egress: { id: 'egress', outcome: 'running' },
      allowlist: { id: 'allowlist', outcome: 'running' },
      nobyok: { id: 'nobyok', outcome: 'asserted' },
    });
    void runAllowlistLeg();
    // (Re-)mount the probe frame from the host, as a plugin frame is mounted. A
    // fresh query string forces a real reload on every run.
    const f = frameRef.current;
    if (f) f.src = `${isolationProbeUrl()}?run=${Date.now()}`;
  }, [runAllowlistLeg]);

  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      // The frame is an OPAQUE origin, so `ev.origin` is "null" and cannot be used
      // to authenticate. Identify by window reference instead — the only handle
      // nothing else can forge.
      if (!frameRef.current || ev.source !== frameRef.current.contentWindow) return;
      const d = ev.data as Record<string, unknown> | null;
      if (!d || d.probe !== 'openwop-isolation') return;
      if (d.leg === 'isolated') {
        const origin = String(d.origin);
        // An opaque origin serializes as "null"; anything else means the frame
        // shares an origin with the host, i.e. the boundary is gone.
        set({ id: 'isolated', outcome: origin === 'null' ? 'pass' : 'fail', detail: origin });
      }
      if (d.leg === 'egress') {
        set({ id: 'egress', outcome: d.blocked === true ? 'pass' : 'fail', detail: String(d.note ?? '') });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [set]);

  // A probe that never answers is INCONCLUSIVE, never a pass.
  useEffect(() => {
    if (!ran) return undefined;
    const timer = window.setTimeout(() => {
      setResults((prev) => {
        const next = { ...prev };
        for (const id of ['isolated', 'egress'] as const) {
          if (next[id]?.outcome === 'running') next[id] = { id, outcome: 'inconclusive' };
        }
        return next;
      });
    }, PROBE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [ran]);

  const LEGS: Array<{ id: LegResult['id']; label: string }> = [
    { id: 'isolated', label: t('legIsolation') },
    { id: 'egress', label: t('legEgress') },
    { id: 'allowlist', label: t('legAllowlist') },
    { id: 'nobyok', label: t('legNoByok') },
  ];

  return (
    <div className="surface-card u-gap-2 u-p-4">
      <div className="u-flex u-items-center u-gap-2">
        <ShieldIcon />
        <strong>{t('selfTestTitle')}</strong>
      </div>
      <p className="muted u-fs-12 u-m-0">{t('selfTestBlurb')}</p>
      <div>
        <Button variant="quiet" size="sm" onClick={run}>
          {ran ? t('selfTestRerun') : t('selfTestRun')}
        </Button>
      </div>

      {ran ? (
        <ul className="u-gap-1 u-flex u-flex-col u-m-0 u-p-0 u-list-none" aria-live="polite">
          {LEGS.map(({ id, label }) => {
            const r = results[id];
            const outcome = r?.outcome ?? 'running';
            const chip =
              outcome === 'pass' ? 'chip chip--success'
              : outcome === 'fail' ? 'chip chip--danger'
              : outcome === 'asserted' ? 'chip chip--muted'
              : 'chip chip--warning';
            return (
              <li key={id} className="u-flex u-items-center u-gap-2 u-fs-12">
                <span className={chip}>
                  {outcome === 'pass' ? <CheckIcon size={12} /> : outcome === 'fail' ? <AlertIcon size={12} /> : null}
                  {' '}{t(`outcome_${outcome}`)}
                </span>
                <span>{label}</span>
                {r?.detail ? <code className="muted">{r.detail}</code> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {ran ? <p className="u-fs-12 muted u-m-0">{t('selfTestNoByokNote')}</p> : null}

      {/* The probe frame — mounted by src from the host, under the same sandbox
          constant and header policy as a real plugin mount (ADR 0840). */}
      <iframe
        ref={frameRef}
        title={t('selfTestFrameTitle')}
        sandbox={PLUGIN_SANDBOX}
        className="u-hidden"
        aria-hidden="true"
      />
    </div>
  );
}
