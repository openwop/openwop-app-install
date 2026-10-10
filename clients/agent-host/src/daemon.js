// ADR 0785 P2 — `openwop-agent-host run`: the companion's long-lived side.
//
// Holds ONE outbound WebSocket to the workspace (the device socket, Bearer =
// the paired developer key) and turns its control messages into PTY sessions
// running `claude`. Never listens on a port.
//
//   host → companion   open | input | resize | stop | attach | hello
//   companion → host   opened | output | replay | exit | error
//
// Reconnects with capped exponential backoff: Cloud Run ends every request,
// WebSockets included, at its request timeout, so a disconnect is routine, not
// an error. Running PTY sessions survive a reconnect (they belong to this
// process, not to the socket), and a viewer that re-attaches gets the replay.

import { PtySessions } from './ptySessions.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Output coalescing (ADR 0785 Q2): a TUI repaint arrives as dozens of tiny PTY
 *  reads; batching them into one frame per window is what keeps a cross-instance
 *  session's relay traffic (Postgres NOTIFY) bounded. */
export const COALESCE_MS = 16;
export const COALESCE_MAX_BYTES = 16 * 1024;

/** The argv for one interactive Claude Code session. */
export function claudeLaunchArgs({ prompt, settingsPath, mcpConfigPath } = {}) {
  const args = [];
  if (settingsPath) args.push('--settings', settingsPath);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  // A positional prompt starts the session with it submitted (`claude [prompt]`):
  // how the app hands context to a new session WITHOUT typing into a running TUI.
  if (prompt) args.push(prompt);
  return args;
}

export function deviceSocketUrl(apiRoot) {
  return `${apiRoot.replace(/^http/, 'ws')}/host/openwop-app/claude-code/device`;
}

export class AgentHostDaemon {
  /**
   * @param {{
   *   apiRoot: string, token: string, root: string,
   *   command?: string, env?: Record<string,string>,
   *   ptyFactory: (command: string, args: string[], opts: object) => any,
   *   WebSocketImpl?: typeof WebSocket,
   *   launchOptions?: () => { settingsPath?: string, mcpConfigPath?: string },
   *   log?: (msg: string) => void,
   *   setTimer?: (fn: () => void, ms: number) => unknown,
   *   fetchFn?: typeof fetch,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.command = opts.command ?? 'claude';
    this.log = opts.log ?? (() => {});
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
    this.ws = null;
    this.stopped = false;
    this.backoff = MIN_BACKOFF_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    /** True once any handshake succeeded; a failure before that is probed once. */
    this.everOpened = false;
    this.probed = false;
    /** @type {Map<string, {parts: Buffer[], bytes: number, timer: unknown}>} */
    this.pending = new Map();
    this.sessions = new PtySessions({
      ptyFactory: opts.ptyFactory,
      onOutput: (sessionId, _g, chunk) => this.queueOutput(sessionId, chunk),
      onExit: (sessionId, _g, code, requested) => { this.flushOutput(sessionId); this.send({ type: 'exit', sessionId, code, requested }); },
    });
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    this.sessions.stopAll();
    try { this.ws?.close(1000, 'companion stopping'); } catch { /* closed */ }
  }

  queueOutput(sessionId, chunk) {
    let p = this.pending.get(sessionId);
    if (!p) { p = { parts: [], bytes: 0, timer: null }; this.pending.set(sessionId, p); }
    p.parts.push(chunk); p.bytes += chunk.length;
    if (p.bytes >= COALESCE_MAX_BYTES) { this.flushOutput(sessionId); return; }
    if (!p.timer) p.timer = this.setTimer(() => this.flushOutput(sessionId), COALESCE_MS);
  }

  /** Send what is queued NOW. Called before a replay or an exit, so ordering holds:
   *  every byte the snapshot contains has already gone out as live output (which a
   *  re-attaching viewer drops), and nothing it contains follows it. */
  flushOutput(sessionId) {
    const p = this.pending.get(sessionId);
    if (!p) return;
    this.pending.delete(sessionId);
    if (p.timer && typeof p.timer === 'object' && 'unref' in p.timer) clearTimeout(p.timer);
    if (p.bytes > 0) this.send({ type: 'output', sessionId, data: Buffer.concat(p.parts).toString('base64') });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  connect() {
    if (this.stopped) return;
    const url = deviceSocketUrl(this.opts.apiRoot);
    const ws = new this.WebSocketImpl(url, { headers: { authorization: `Bearer ${this.opts.token}` } });
    this.ws = ws;
    ws.onopen = () => { this.backoff = MIN_BACKOFF_MS; this.everOpened = true; this.log(`connected to ${this.opts.apiRoot}`); };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4001) { this.log(`the workspace closed this device: ${ev.reason || 'revoked'}. Pair again to reconnect.`); this.stopped = true; this.sessions.stopAll(); return; }
      if (this.stopped) return;
      // A handshake that never opened says nothing about WHY (the WebSocket API hides
      // the HTTP status). Ask once, cheaply, whether the key itself is refused, so a
      // revoked or expired pairing says so instead of retrying silently forever
      // (observed 2026-10-05: a user revoked the device they were running).
      if (!this.everOpened && !this.probed) {
        this.probed = true;
        void this.keyRefused().then((refused) => {
          if (!refused || this.stopped) return;
          this.stopped = true;
          this.log('this device\'s key was refused: it was revoked or has expired. Run `openwop-agent-host pair` again, then `run`.');
        });
      }
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.log(`disconnected (${ev.code}); reconnecting in ${Math.round(wait / 1000)}s`);
      this.setTimer(() => this.connect(), wait);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  /** True only on an explicit 401 from an authenticated endpoint; any other answer
   *  (or a network failure) is not evidence about the key. */
  async keyRefused() {
    try {
      const res = await this.fetchFn(`${this.opts.apiRoot}/host/openwop-app/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
        signal: AbortSignal.timeout(5000),
      });
      return res.status === 401;
    } catch {
      return false;
    }
  }

  handle(msg) {
    switch (msg.type) {
      case 'hello': return;
      case 'task':
        // ADR 0785 P5 — one app-dispatched task, run headless; the result goes back over HTTP.
        if (this.opts.taskRunner) void this.opts.taskRunner.run(msg);
        return;
      case 'open': {
        const { remoteSettingsPath, ...extra } = this.opts.launchOptions?.() ?? {};
        // ADR 0785 P4 — the opt-in session gets the settings carrying the hook.
        if (msg.approveFromAnywhere && remoteSettingsPath) extra.settingsPath = remoteSettingsPath;
        try {
          const generation = this.sessions.start(msg.sessionId, {
            command: this.command,
            args: claudeLaunchArgs({ prompt: msg.prompt, ...extra }),
            cwd: this.opts.root,
            env: this.opts.env ?? process.env,
            cols: msg.cols, rows: msg.rows,
          });
          this.send({ type: 'opened', sessionId: msg.sessionId, generation });
        } catch (err) {
          this.send({ type: 'error', sessionId: msg.sessionId, message: `Could not start ${this.command}: ${err instanceof Error ? err.message : String(err)}` });
          this.send({ type: 'exit', sessionId: msg.sessionId, code: null, requested: false });
        }
        return;
      }
      case 'input':
        this.sessions.write(msg.sessionId, Buffer.from(String(msg.data ?? ''), 'base64').toString('utf8'));
        return;
      case 'resize':
        this.sessions.resize(msg.sessionId, msg.cols, msg.rows);
        return;
      case 'stop':
        this.sessions.stop(msg.sessionId);
        return;
      case 'attach':
        // The snapshot is sent on the SAME ordered socket as live output, so every
        // byte already emitted is inside it (the relay's replay-ordering argument).
        this.flushOutput(msg.sessionId);
        this.send({ type: 'replay', sessionId: msg.sessionId, viewerId: msg.viewerId, data: this.sessions.replay(msg.sessionId).toString('base64') });
        return;
      default:
    }
  }
}
