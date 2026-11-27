/**
 * ADR 1099 P4 — the client portal page's two parts below the project view.
 *
 *  - `PortalSections` (D10): the sections features add to the grant's view. The
 *    SERVER lists which sections this grant gets and in what order; a section is
 *    mounted only when a feature registered a component for that exact id, and the
 *    component receives its own section's data only. A least view
 *    (`{ available: false, message }`) is rendered here, the same for every
 *    section, and the component is not mounted. Sections re-read after every
 *    answered turn and when the page comes back into view (the firm approves
 *    answers elsewhere, which can change what is due).
 *  - `PortalChat` (D9): the conversation with the project agent, through the
 *    shared `chat/ConversationView` in its `outsider` mode. Not a second chat:
 *    the transport is the collaborator-turn lane (P2) and the host-kept history
 *    (P3d); this file only maps them onto the view's props.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConversationView } from '../../chat/ConversationView.js';
import type { ChatMessage } from '../../chat/types.js';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { confirm } from '../../ui/confirm.js';
import { featurePortalSections } from '../featureExtensions.js';
import type { FeaturePortalSection } from '../registry.js';
import {
  clearPortalTurns, CollabError, listPortalSections, listPortalTurns, readPortalSection, sendPortalTurn, type PortalTurn,
} from './collabClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

// ── sections ──

/** Re-read on focus/visibility at most this often (the server also bounds reads). */
const REFRESH_MIN_MS = 15_000;

function useRefreshOnReturn(refresh: () => void): void {
  const last = useRef(Date.now());
  useEffect(() => {
    const onReturn = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - last.current < REFRESH_MIN_MS) return;
      last.current = Date.now();
      refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => { window.removeEventListener('focus', onReturn); document.removeEventListener('visibilitychange', onReturn); };
  }, [refresh]);
}

export type SectionState = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ok'; data: Record<string, unknown> };

function sectionError(e: unknown, t: TFn): string {
  if (e instanceof CollabError && e.status === 429) return t('portalSectionBusy');
  // A section's own typed refusal (4xx) carries a sentence written for the person.
  if (e instanceof CollabError && e.status >= 400 && e.status < 500 && e.status !== 404 && e.message) return e.message;
  return t('portalSectionFailed');
}

function PortalSection({ grantId, def, nonce }: { grantId: string; def: FeaturePortalSection; nonce: number }): JSX.Element {
  const { t } = useTranslation('collab');
  const [s, setS] = useState<SectionState>({ state: 'loading' });
  const [own, setOwn] = useState(0);
  useEffect(() => {
    let live = true;
    void readPortalSection(grantId, def.id)
      .then((data) => { if (live) setS({ state: 'ok', data }); })
      .catch((e: unknown) => { if (live) setS({ state: 'failed', message: sectionError(e, t) }); });
    return () => { live = false; };
  }, [grantId, def.id, nonce, own, t]);
  const refresh = useCallback(() => setOwn((n) => n + 1), []);
  return <PortalSectionFrame grantId={grantId} def={def} state={s} refresh={refresh} />;
}

/**
 * One section in the host's frame: its heading, and the loading, failed, least-view
 * or loaded state. Pure (no fetch), so an adopter's test can mount its component
 * with fixture data exactly as the portal page will:
 * `<PortalSectionFrame grantId="g" def={mySection} state={{ state: 'ok', data }} refresh={() => {}} />`.
 */
export function PortalSectionFrame({ grantId, def, state: s, refresh }: {
  grantId: string; def: FeaturePortalSection; state: SectionState; refresh: () => void;
}): JSX.Element {
  const { t } = useTranslation('collab');
  const { t: tf } = useTranslation(def.i18nNamespace);
  const headingId = `portal-section-${def.id.replace(/[^a-z0-9-]/gi, '-')}`;
  const Component = def.component;
  let body: JSX.Element;
  if (s.state === 'loading') body = <InlineState kind="loading" message={t('loading')} />;
  else if (s.state === 'failed') body = <InlineState kind="failed" message={s.message} action={<Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>} />;
  else if (s.data.available === false) body = <p className="u-text-muted u-m-0">{typeof s.data.message === 'string' && s.data.message ? s.data.message : t('portalSectionNothing')}</p>;
  else body = <Component grantId={grantId} data={s.data} refresh={refresh} />;
  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby={headingId} data-portal-section={def.id}>
      <h2 id={headingId} className="u-m-0 u-fs-16">{tf(def.titleKey)}</h2>
      {body}
    </section>
  );
}

/**
 * The sections the server lists for this grant that a feature can render, in the
 * server's order. `registered` is a seam for tests; the page passes nothing.
 */
export function PortalSections({ grantId, kind, nonce, registered }: {
  grantId: string; kind: string; nonce: number; registered?: readonly FeaturePortalSection[];
}): JSX.Element | null {
  const defs = useMemo(() => (registered ?? featurePortalSections()).filter((d) => d.kind === kind), [registered, kind]);
  const [listed, setListed] = useState<Array<{ id: string; order: number }> | null>(null);
  const [returnNonce, setReturnNonce] = useState(0);
  useRefreshOnReturn(useCallback(() => setReturnNonce((n) => n + 1), []));
  useEffect(() => {
    if (defs.length === 0) return undefined;
    let live = true;
    // A failed list shows no sections rather than an error: the project view and
    // the chat still work, and each section has its own failure state once listed.
    void listPortalSections(grantId).then((l) => { if (live) setListed(l); }).catch(() => { if (live) setListed((prev) => prev ?? []); });
    return () => { live = false; };
  }, [grantId, defs.length, nonce, returnNonce]);
  if (defs.length === 0 || !listed) return null;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const shown = listed.map((l) => byId.get(l.id)).filter((d): d is FeaturePortalSection => !!d);
  if (shown.length === 0) return null;
  return <>{shown.map((d) => <PortalSection key={d.id} grantId={grantId} def={d} nonce={nonce + returnNonce} />)}</>;
}

// ── the chat ──

const toMessage = (m: PortalTurn, i: number): ChatMessage => ({
  id: `portal-${i}-${m.at}`,
  role: m.role === 'collaborator' ? 'user' : 'assistant',
  content: m.text,
  createdAt: m.at,
});

function turnError(e: unknown, t: TFn): string {
  if (e instanceof CollabError && e.status === 429) return t('portalChatLimit');
  if (e instanceof CollabError && e.status === 503) return t('portalChatUnavailable');
  if (e instanceof CollabError && e.status === 404) return t('portalChatGone');
  if (e instanceof CollabError && e.status === 400 && e.message) return e.message;
  return t('portalChatFailed');
}

/** The conversation with the project agent. `onAnswered` runs after each answered turn. */
export function PortalChat({ grantId, onAnswered }: { grantId: string; onAnswered: () => void }): JSX.Element {
  const { t } = useTranslation('collab');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    setLoadFailed(false);
    void listPortalTurns(grantId).then((m) => setMessages(m.map(toMessage))).catch(() => setLoadFailed(true));
  }, [grantId]);
  useEffect(load, [load]);

  const send = useCallback((text: string): void => {
    const message = text.trim();
    if (!message || sending) return;
    setError(null);
    setSending(true);
    const n = ++seq.current;
    setMessages((prev) => [...(prev ?? []), { id: `portal-out-${n}`, role: 'user', content: message, createdAt: new Date().toISOString() }]);
    void sendPortalTurn(grantId, message)
      .then((reply) => {
        setMessages((prev) => [...(prev ?? []), { id: `portal-in-${n}`, role: 'assistant', content: reply, createdAt: new Date().toISOString() }]);
        onAnswered();
      })
      .catch((e: unknown) => {
        // The host remembers only answered exchanges, so the unanswered line goes.
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== `portal-out-${n}`));
        setError(turnError(e, t));
      })
      .finally(() => setSending(false));
  }, [grantId, onAnswered, sending, t]);

  const startOver = async (): Promise<void> => {
    const ok = await confirm({ title: t('portalChatClearTitle'), body: t('portalChatClearBody'), confirmLabel: t('portalChatClear'), danger: true });
    if (!ok) return;
    try { await clearPortalTurns(grantId); setMessages([]); setError(null); }
    catch { setError(t('portalChatClearFailed')); }
  };

  return (
    <section id="portal-chat" className="surface-card u-grid u-gap-3" aria-labelledby="portal-chat-title" tabIndex={-1}>
      <div className="u-flex u-flex-wrap u-items-center u-justify-between u-gap-2">
        <h2 id="portal-chat-title" className="u-m-0 u-fs-16">{t('portalChatTitle')}</h2>
        {messages && messages.length > 0 ? <Button variant="quiet" size="sm" onClick={() => void startOver()} disabled={sending}>{t('portalChatClear')}</Button> : null}
      </div>
      <p className="u-text-muted u-m-0 u-fs-13">{t('portalChatLede')}</p>
      {loadFailed ? <InlineState kind="failed" message={t('portalChatLoadFailed')} action={<Button variant="secondary" size="sm" onClick={load}>{t('retry')}</Button>} /> : null}
      {!loadFailed && messages === null ? <InlineState kind="loading" message={t('loading')} /> : null}
      {messages !== null ? (
        <div className="u-flex u-flex-col">
          <ConversationView
            outsider
            messages={messages}
            // Used only for run and card contexts, which this lane never produces;
            // the viewer's own workspace is never named here.
            tenantId=""
            error={error}
            isSending={sending}
            onPickSuggestion={send}
            renderEmptyState={() => <p className="u-text-muted u-m-0 u-p-3">{t('portalChatEmpty')}</p>}
            onSend={(text) => send(text)}
            onCancel={null}
            supportsAudioInput={false}
            supportsImageInput={false}
            supportsPdfInput={false}
            onResolveInterrupt={async () => { /* the collaborator lane raises no interrupts */ }}
            onReconfigureBYOK={() => { /* the firm's credential answers; nothing to configure */ }}
            hasOlderMessages={false}
            isLoadingEarlier={false}
            onLoadEarlier={() => { /* the host keeps the last 40 lines, all loaded */ }}
            composerPlaceholder={t('portalChatPlaceholder')}
          />
        </div>
      ) : null}
    </section>
  );
}
