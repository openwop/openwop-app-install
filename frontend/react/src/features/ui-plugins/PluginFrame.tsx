/**
 * PluginFrame — the front-end LOADER boundary for RFC 0117/0119 front-end plugin
 * packs (ADR 0300). SECURITY-CRITICAL: mounts a DOWNLOADED, untrusted plugin
 * `entry` bundle and drives it over the ui-plugin/1 host-RPC channel.
 *
 * Isolation (mirrors chat/artifacts/SandboxedArtifactFrame, reviewed via /architect):
 *  - `sandbox="allow-scripts"` WITHOUT `allow-same-origin` → the framed document has
 *    an OPAQUE/null origin (`frontend-plugin-isolation`): it cannot read the parent
 *    DOM, cookies, or storage, nor make credentialed same-origin requests. This is
 *    the host's advertised `cross-origin-iframe` mechanism (RFC 0119) — the same
 *    value `/ui-plugin/packs` reports, so advertise and apply can't drift.
 *  - The entry is mounted via `srcdoc` carrying a DENY-EGRESS CSP
 *    (`default-src 'none'`, no `connect-src` → `frontend-plugin-egress`): a plugin
 *    that tries to `fetch()` out is blocked, so it can exfiltrate nothing it sees.
 *  - The plugin talks to the host ONLY through ui-plugin/1 postMessage. Every inbound
 *    request is checked against the plugin's DECLARED `hostApi` (its closed allowlist,
 *    `frontend-plugin-rpc-allowlist`) BEFORE it is forwarded to the canonical host
 *    seam — an undeclared method is answered `method_not_allowed`, never executed.
 *  - No credential-bearing method exists in the host allowlist
 *    (`frontend-plugin-no-byok`) — the plugin can never read BYOK material.
 *
 * The loader is a thin bridge: it NEVER dispatches host logic itself — it forwards
 * allowed requests to `POST …/ui-plugin/rpc` (the single-source host dispatcher that
 * enforces the host allowlist + tenant isolation + canvas concurrency) and posts the
 * response back into the frame.
 *
 * @see docs/adr/0300-frontend-plugin-loader-rfc-0117-0119.md
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { callHostRpc, entryUrl, type ServedPlugin } from './pluginClient.js';

const UI_PLUGIN_PROTOCOL = 'ui-plugin/1';

/** The DENY-EGRESS CSP applied to the plugin document (mirror of the host's
 *  `pluginIframeCsp()`): `default-src 'none'` + NO `connect-src` ⇒ no network egress
 *  beyond the ui-plugin/1 postMessage channel. */
export const PLUGIN_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:;";

/** allow-scripts ONLY — the deliberate ABSENCE of allow-same-origin is what makes
 *  the frame a distinct opaque origin (the isolation boundary). */
export const PLUGIN_SANDBOX = 'allow-scripts';

/** Inject the deny-egress CSP as the first `<head>` child so it governs the whole
 *  untrusted document (a `<meta>` CSP must precede any resource load). */
export function withPluginCsp(html: string, csp: string = PLUGIN_CSP): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

interface UiPluginRequest {
  openwop: typeof UI_PLUGIN_PROTOCOL;
  id: number;
  type: 'request';
  method: string;
  params?: unknown;
}
function isRequest(m: unknown): m is UiPluginRequest {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return r.openwop === UI_PLUGIN_PROTOCOL && r.type === 'request' && typeof r.id === 'number' && typeof r.method === 'string';
}

interface Props {
  plugin: ServedPlugin;
  /** The artifact the viewer reads over ui-plugin/1 (host.init payload). */
  artifactId: string;
  title: string;
  /** Localized status copy (the feature owns its i18n; passed from the page's `t`). */
  loadingLabel: string;
  errorLabel: string;
  /** RFC 0130 (canvas-preview): the live edited document. A change posts a
   *  `host.documentChanged` event into the frame. */
  docContent?: string;
  /** RFC 0130 (canvas-preview): the editor selection. A change posts a
   *  `host.selectionChanged` event (advisory highlighting only). */
  selection?: unknown;
  /** RFC 0130: relay for plugin `host.announce` requests — the host page's
   *  accessibility live region (the sandbox is invisible to page-level AT). */
  onAnnounce?: (message: string, politeness: 'polite' | 'assertive') => void;
}

/** RFC 0130: hosts MUST length-cap announce text (SHOULD ≤ 400 chars, truncating). */
const ANNOUNCE_MAX_CHARS = 400;
/** RFC 0130: hosts SHOULD rate-limit announces — excess is refused with an
 *  ordinary error response on the existing channel (no new error code). */
const ANNOUNCE_MIN_INTERVAL_MS = 1000;

/** Build the message handler for one mounted plugin. Exported for unit tests so the
 *  allowlist + forward-vs-reject decision is verified without a real iframe.
 *  `host.announce` (RFC 0130) is handled FRAME-LOCALLY: the live-region relay is a
 *  page concern, so it never round-trips the backend seam — but it still sits
 *  behind the plugin's declared-hostApi gate like every other method. */
export function makePluginMessageHandler(
  plugin: ServedPlugin,
  post: (msg: unknown) => void,
  forward: (message: unknown) => Promise<unknown> = callHostRpc,
  onAnnounce?: (message: string, politeness: 'polite' | 'assertive') => void,
  // The rate-limit clock OUTLIVES handler recreation (a re-render re-creates
  // the handler; a fresh clock would reset the limiter — grade pass GC-CV-3).
  announceClock: { last: number } = { last: 0 },
): (data: unknown) => Promise<void> {
  const allow = new Set<string>(plugin.hostApi);
  return async (data: unknown): Promise<void> => {
    if (!isRequest(data)) return; // RFC 0117 §5: ignore anything not a ui-plugin/1 request
    if (!allow.has(data.method)) {
      // Plugin-scoped allowlist gate (frontend-plugin-rpc-allowlist) — reject BEFORE
      // the host is ever contacted; an undeclared method is never executed.
      post({ openwop: UI_PLUGIN_PROTOCOL, id: data.id, type: 'response', ok: false, error: { code: 'method_not_allowed', message: `method '${data.method}' is not in this plugin's hostApi` } });
      return;
    }
    if (data.method === 'host.announce') {
      const p = (data.params ?? {}) as Record<string, unknown>;
      if (typeof p.message !== 'string') {
        post({ openwop: UI_PLUGIN_PROTOCOL, id: data.id, type: 'response', ok: false, error: { code: 'handler_error', message: "'message' must be a string" } });
        return;
      }
      const now = Date.now();
      if (now - announceClock.last < ANNOUNCE_MIN_INTERVAL_MS) {
        post({ openwop: UI_PLUGIN_PROTOCOL, id: data.id, type: 'response', ok: false, error: { code: 'handler_error', message: 'rate limited' } });
        return;
      }
      announceClock.last = now;
      const politeness = p.politeness === 'assertive' ? 'assertive' : 'polite';
      onAnnounce?.(p.message.slice(0, ANNOUNCE_MAX_CHARS), politeness);
      post({ openwop: UI_PLUGIN_PROTOCOL, id: data.id, type: 'response', ok: true, result: {} });
      return;
    }
    const response = await forward(data);
    post(response);
  };
}

/** UPU-1 — how long to wait for a plugin's entry bytes before calling the load failed.
 *  Generous (a plugin bundle may be large on a slow link) but finite: an unbounded wait
 *  is indistinguishable from a working download that never finishes. */
const ENTRY_FETCH_TIMEOUT_MS = 15_000;

export function PluginFrame({ plugin, artifactId, title, loadingLabel, errorLabel, docContent, selection, onAnnounce }: Props): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const announceClock = useRef({ last: 0 });
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = useMemo(() => entryUrl(plugin), [plugin]);

  // Download the entry bytes → wrap in a deny-egress-CSP srcdoc (opaque origin mount).
  //
  // UPU-1 — BOUNDED. An `entryUrl` that never answers (a plugin host that accepts the
  // connection and stalls) used to leave the `aria-busy` spinner up forever: no error, no
  // timeout, nothing to retry — the surface simply lied about being in progress. The
  // sibling `IsolationSelfTest` already carries the principle this copies: "a timeout is
  // NOT a pass — an unanswered probe proves nothing either way". So the fetch is bounded
  // and a timeout gets its OWN message, distinguishable from a network or status failure,
  // because "the plugin host did not answer" and "the plugin host refused" are different
  // things to the person deciding whether to trust it.
  useEffect(() => {
    let alive = true;
    setSrcDoc(null); setError(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), ENTRY_FETCH_TIMEOUT_MS);
    void fetch(url, { signal: ctrl.signal })
      .then((r) => { if (!r.ok) throw new Error(`entry ${r.status}`); return r.text(); })
      .then((html) => { if (alive) setSrcDoc(withPluginCsp(html)); })
      .catch((e) => {
        if (!alive) return;
        const timedOut = ctrl.signal.aborted;
        setError(timedOut
          ? `timed out after ${Math.round(ENTRY_FETCH_TIMEOUT_MS / 1000)}s`
          : e instanceof Error ? e.message : String(e));
      })
      .finally(() => { window.clearTimeout(timer); });
    return () => { alive = false; window.clearTimeout(timer); ctrl.abort(); };
  }, [url]);

  // Bridge ui-plugin/1 postMessage ⇄ the canonical host seam, scoped to THIS frame.
  useEffect(() => {
    const frameWin = () => iframeRef.current?.contentWindow ?? null;
    const post = (msg: unknown): void => frameWin()?.postMessage(msg, '*');
    const handle = makePluginMessageHandler(plugin, post, callHostRpc, onAnnounce, announceClock.current);

    const onMessage = (ev: MessageEvent): void => {
      // Only accept messages from OUR frame (the opaque-origin child) — ignore the rest.
      if (ev.source !== frameWin()) return;
      const data = ev.data as { openwop?: unknown; type?: unknown; event?: unknown };
      if (data?.openwop !== UI_PLUGIN_PROTOCOL) return;
      // When the plugin announces readiness, hand it the artifact to read (host.init).
      if (data.type === 'event' && data.event === 'plugin.ready') {
        post({ openwop: UI_PLUGIN_PROTOCOL, type: 'event', event: 'host.init', data: { artifactId } });
        return;
      }
      void handle(ev.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [plugin, artifactId, onAnnounce]);

  // RFC 0130 (canvas-preview): push live editor state into the frame as events.
  // Prop changes ARE the debounce boundary — the chassis batches via its own
  // history state, and plugins treat the latest event as authoritative.
  useEffect(() => {
    if (docContent === undefined) return;
    iframeRef.current?.contentWindow?.postMessage({ openwop: UI_PLUGIN_PROTOCOL, type: 'event', event: 'host.documentChanged', data: { content: docContent } }, '*');
  }, [docContent]);
  useEffect(() => {
    if (selection === undefined) return;
    iframeRef.current?.contentWindow?.postMessage({ openwop: UI_PLUGIN_PROTOCOL, type: 'event', event: 'host.selectionChanged', data: { selection } }, '*');
  }, [selection]);

  if (error) {
    return (
      <div className="chip chip--danger" role="alert">
        <span>{errorLabel}</span>
        <span>: {error}</span>
      </div>
    );
  }
  if (srcDoc === null) return <div className="muted" role="status" aria-busy="true">{loadingLabel}</div>;

  return (
    <iframe
      ref={iframeRef}
      sandbox={PLUGIN_SANDBOX}
      srcDoc={srcDoc}
      title={title}
      referrerPolicy="no-referrer"
      className="uiplugin-frame"
    />
  );
}
