/**
 * A Claude Code terminal as a chat-deck tab (ADR 0785 P2 / D5).
 *
 * What this is NOT: a chat. It renders the user's own Claude Code TUI, running
 * on their own machine, through the D4 relay. It has no composer, no messages
 * and no model call from this host — which is why it is a registered deck tab
 * KIND and not a conversation (CLAUDE.md "AI chat — reuse, never recreate").
 *
 * Flow: pick a paired device (online) → the host tells the companion to start
 * `claude` → this tab mints a 60-second viewer ticket and connects a WebSocket
 * straight to the backend origin (the CDN does not carry WebSockets, the same
 * reason collab uses `sseBaseUrl`) → bytes in, keystrokes out.
 *
 * Terminal details carried from the prior art: Shift+Enter sends CSI-u
 * (ESC[13;2u), which Claude Code reads as a newline; resize is debounced 220 ms;
 * a disconnect is shown plainly with a reconnect action (the companion keeps
 * the session running, and the replay buffer restores the screen).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { CheckboxField, SelectField } from '../../ui/Field.js';
import { TerminalIcon } from '../../ui/icons/index.js';
import type { DeckTabKindProps } from '../../chat/tabDeck/tabKindRegistry.js';
import { tabStore, viewerSocketUrl } from './terminalTabStore.js';
import { ClaudeCodeApiError, listDevices, mintTerminalTicket, openTerminal, type DeviceView } from './claudeCodeClient.js';

const RESIZE_DEBOUNCE_MS = 220;
const SHIFT_ENTER = '\u001b[13;2u';

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function themeFromTokens(): { background: string; foreground: string; cursor: string } {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return { background: v('--paper'), foreground: v('--ink'), cursor: v('--color-ai') || v('--ink') };
}

type Phase =
  | { kind: 'pick' }
  | { kind: 'starting' }
  | { kind: 'connecting'; sessionId: string }
  | { kind: 'live'; sessionId: string }
  | { kind: 'disconnected'; sessionId: string }
  | { kind: 'exited'; sessionId: string; code: number | null };

export function ClaudeCodeTerminalTab({ tabId, active, setTitle, launchContext }: DeckTabKindProps): JSX.Element {
  const { t } = useTranslation('claude-code');
  const stored = tabStore.get(tabId);
  const [phase, setPhase] = useState<Phase>(stored ? { kind: 'connecting', sessionId: stored } : { kind: 'pick' });
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [deviceId, setDeviceId] = useState('');
  // ADR 0785 P4 — opt-in: this session's permission prompts also become approval cards.
  const [approveAnywhere, setApproveAnywhere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Devices for the picker.
  useEffect(() => {
    if (phase.kind !== 'pick') return;
    let cancelled = false;
    listDevices().then((all) => {
      if (cancelled) return;
      const usable = all.filter((d) => d.status === 'active');
      setDevices(usable);
      const firstOnline = usable.find((d) => d.online);
      if (firstOnline) setDeviceId(firstOnline.deviceId);
    }).catch(() => { if (!cancelled) setError(t('terminalDevicesFailed')); });
    return () => { cancelled = true; };
  }, [phase.kind, t]);

  // One xterm per tab, created once the host element exists.
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13,
      theme: themeFromTokens(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey) {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: b64(SHIFT_ENTER) }));
        return false;
      }
      return true;
    });
    term.onData((d) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: b64(d) }));
    });
    termRef.current = term; fitRef.current = fit;
    try { fit.fit(); } catch { /* not laid out yet */ }
    return () => { term.dispose(); termRef.current = null; fitRef.current = null; };
  }, []);

  // Debounced fit + resize while visible.
  useEffect(() => {
    if (!active || !hostRef.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const fit = fitRef.current; const term = termRef.current;
        if (!fit || !term) return;
        try { fit.fit(); } catch { return; }
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(hostRef.current);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [active]);

  const connect = useCallback(async (sessionId: string) => {
    setError(null);
    setPhase({ kind: 'connecting', sessionId });
    let ticket: { ticket: string; path: string };
    try { ticket = await mintTerminalTicket(sessionId); } catch (err) {
      if (err instanceof ClaudeCodeApiError && err.status === 404) { tabStore.clear(tabId); setPhase({ kind: 'pick' }); return; }
      setError(t('terminalConnectFailed')); setPhase({ kind: 'disconnected', sessionId }); return;
    }
    const ws = new WebSocket(viewerSocketUrl(ticket.path, ticket.ticket));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    let exited = false;
    ws.onopen = () => {
      setPhase({ kind: 'live', sessionId });
      termRef.current?.reset();
      const term = termRef.current;
      if (term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term?.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { termRef.current?.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
      let m: { type?: string; code?: number | null; message?: string };
      try { m = JSON.parse(ev.data) as typeof m; } catch { return; }
      if (m.type === 'exit') { exited = true; setPhase({ kind: 'exited', sessionId, code: m.code ?? null }); }
      else if (m.type === 'error') setError(m.message ?? t('terminalConnectFailed'));
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (!exited) setPhase({ kind: 'disconnected', sessionId });
    };
  }, [t, tabId]);

  // Reattach a restored tab once; close the socket (NOT the session) on unmount —
  // navigating away must not stop Claude Code (closing the TAB does, via onClose).
  const reattached = useRef(false);
  useEffect(() => {
    if (reattached.current) return;
    reattached.current = true;
    const restored = tabStore.get(tabId);
    if (restored) void connect(restored);
  }, [connect, tabId]);
  useEffect(() => () => { const ws = wsRef.current; wsRef.current = null; ws?.close(); }, []);

  const start = useCallback(async () => {
    if (!deviceId) return;
    setError(null);
    setPhase({ kind: 'starting' });
    const term = termRef.current;
    try {
      const session = await openTerminal({ deviceId, cols: term?.cols ?? 120, rows: term?.rows ?? 32, ...(launchContext ? { prompt: launchContext } : {}), ...(approveAnywhere ? { approveFromAnywhere: true } : {}) });
      tabStore.set(tabId, session.sessionId);
      setTitle(session.title);
      await connect(session.sessionId);
    } catch (err) {
      setError(err instanceof ClaudeCodeApiError && err.reason === 'device_offline' ? t('terminalDeviceOffline') : t('terminalStartFailed'));
      setPhase({ kind: 'pick' });
    }
  }, [connect, deviceId, setTitle, t, tabId, launchContext, approveAnywhere]);

  // Opened from a page ("Open in Claude Code" on a workflow/run): with exactly one
  // online device there is nothing to choose, so start straight away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !launchContext || phase.kind !== 'pick' || !devices) return;
    const online = devices.filter((d) => d.online);
    if (online.length === 1 && deviceId === online[0]!.deviceId) { autoStarted.current = true; void start(); }
  }, [launchContext, phase.kind, devices, deviceId, start]);

  const showTerminal = phase.kind === 'live' || phase.kind === 'connecting' || phase.kind === 'disconnected' || phase.kind === 'exited';

  return (
    <div className="cc-terminal-tab u-flex u-flex-col u-flex-1 u-minh-0" data-walkthrough="claude-code.terminal">
      {error ? <Notice variant="warning" announce={error}>{error}</Notice> : null}

      {phase.kind === 'pick' || phase.kind === 'starting' ? (
        devices === null && !error ? (
          <StateCard loading title={t('terminalLoading')} />
        ) : devices && devices.length === 0 ? (
          <StateCard
            icon={<TerminalIcon size={20} />}
            title={t('terminalNoDevicesTitle')}
            body={t('terminalNoDevicesBody')}
            action={<Link to="/claude-code">{t('terminalPairLink')}</Link>}
          />
        ) : (
          <div className="surface-card cc-terminal-pick u-p-4 u-flex u-flex-col u-gap-3">
            <h2 className="u-m-0">{t('terminalPickTitle')}</h2>
            <p className="u-m-0">{t('terminalPickBody')}</p>
            {launchContext ? <p className="u-m-0"><strong>{t('terminalWillStartWith')}</strong> {launchContext}</p> : null}
            <SelectField
              label={t('terminalDevice')}
              value={deviceId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDeviceId(e.target.value)}
            >
              <option value="">{t('terminalChooseDevice')}</option>
              {(devices ?? []).map((d) => (
                <option key={d.deviceId} value={d.deviceId} disabled={!d.online}>
                  {d.online ? d.label : t('terminalDeviceOfflineOption', { label: d.label })}
                </option>
              ))}
            </SelectField>
            {devices && !devices.some((d) => d.online) ? <p className="u-m-0">{t('terminalRunHint')}</p> : null}
            <CheckboxField
              label={t('terminalApproveAnywhere')}
              help={t('terminalApproveAnywhereHelp')}
              checked={approveAnywhere}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApproveAnywhere(e.target.checked)}
            />
            <div>
              <Button variant="primary" loading={phase.kind === 'starting'} disabled={!deviceId || phase.kind === 'starting'} onClick={() => { void start(); }}>
                {t('terminalStart')}
              </Button>
            </div>
          </div>
        )
      ) : null}

      {phase.kind === 'disconnected' ? (
        <div className="action-bar u-px-3">
          <span>{t('terminalDisconnected')}</span>
          <Button size="sm" variant="secondary" onClick={() => { void connect(phase.sessionId); }}>{t('terminalReconnect')}</Button>
        </div>
      ) : null}
      {phase.kind === 'exited' ? (
        <div className="action-bar u-px-3">
          <span>{t('terminalExited', { code: phase.code ?? '—' })}</span>
          <Button size="sm" variant="secondary" onClick={() => { tabStore.clear(tabId); setPhase({ kind: 'pick' }); }}>{t('terminalNewSession')}</Button>
        </div>
      ) : null}

      {/* The xterm host stays mounted (hidden while picking) so the terminal keeps
          its scrollback across reconnects. */}
      <div
        ref={hostRef}
        className="cc-terminal"
        role="region"
        aria-label={t('terminalAria')}
        hidden={!showTerminal}
      />
    </div>
  );
}
