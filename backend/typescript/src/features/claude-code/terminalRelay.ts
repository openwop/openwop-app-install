/**
 * ADR 0785 D4 — the terminal relay: bytes between a companion's PTY and the
 * browsers viewing it, possibly on different Cloud Run instances.
 *
 * Nothing here listens on the user's machine: the companion's DEVICE socket and
 * each browser's VIEWER socket both connect out to this host. The relay is a
 * class over an injected pub/sub so a test can run two "instances" in one
 * process and prove the cross-instance path, not just the local one.
 *
 * Routing:
 *   - control → device: delivered to the local device socket, or published on
 *     `cc:dev:<deviceId>`, which only the instance holding that socket listens on.
 *   - output → viewers: delivered to local viewers; published on
 *     `cc:term:<sessionId>` ONLY while some other instance has declared interest
 *     (a viewer there pings every INTEREST_PING_MS). A same-instance session costs
 *     the database nothing — the ADR 0785 Q2 budget concern.
 *   - Published frames stay under Postgres NOTIFY's 8000-byte payload limit:
 *     raw bytes are chunked at CHUNK_BYTES before base64 (ADR 0785 D4 correction).
 *
 * Replay ordering (why a re-attaching viewer never sees garbage): the device's
 * socket is ordered, and it answers an `attach` with a snapshot of its replay
 * buffer. Every output byte sent BEFORE that snapshot is inside it, so a viewer
 * awaiting its replay DROPS live output until the replay arrives, then receives
 * the snapshot, then live bytes. Pub/sub preserves per-channel order, so the same
 * holds across instances.
 */
import { randomBytes } from 'node:crypto';

export const CHUNK_BYTES = 4096;
export const INTEREST_TTL_MS = 45_000;
export const INTEREST_PING_MS = 15_000;

export type PublishFn = (channel: string, payload: string) => Promise<void>;
export type SubscribeFn = (channel: string, handler: (payload: string) => void) => Promise<() => Promise<void>>;

/** What the relay needs from a live socket (a `ws` WebSocket satisfies it). */
export interface RelayConn {
  sendJson(msg: unknown): void;
  sendBinary(data: Buffer): void;
  close(code: number, reason: string): void;
}

/** Control messages the relay sends TO a device. */
export type DeviceControl =
  | { type: 'open'; sessionId: string; cols: number; rows: number; prompt?: string; approveFromAnywhere?: boolean }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'stop'; sessionId: string }
  | { type: 'attach'; sessionId: string; viewerId: string }
  /** ADR 0785 P5 — one app-dispatched task, in RFC 0122's dispatch-frame shape (+ taskId). */
  | { type: 'task'; taskId: string; runId: string; stepId: string; seq: number; kind: 'tool'; tool: string; inputs: Record<string, unknown> };

/** Frames a device SENDS (validated by the socket layer before they reach here). */
export type DeviceFrame =
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'replay'; sessionId: string; viewerId: string; data: string }
  | { type: 'opened'; sessionId: string; generation: number }
  | { type: 'exit'; sessionId: string; code: number | null; requested: boolean }
  | { type: 'error'; sessionId: string; message: string };

type TermEvent =
  | { k: 'o'; d: string }
  | { k: 'r'; v: string; d: string; last: boolean }
  | { k: 'x'; code: number | null; requested: boolean }
  | { k: 'e'; message: string };

type DevBus = DeviceControl | { type: 'interest'; sessionId: string; instanceId: string } | { type: 'close'; reason: string };

interface ViewerState { conn: RelayConn; awaitingReplay: boolean; replayParts: Buffer[] }

export interface RelayHooks {
  onOpened?: (sessionId: string) => void;
  onExit?: (sessionId: string, code: number | null) => void;
}

export class TerminalRelay {
  readonly instanceId: string;
  private readonly publish: PublishFn;
  private readonly subscribe: SubscribeFn;
  private readonly hooks: RelayHooks;
  private readonly devices = new Map<string, { conn: RelayConn; unsubscribe: () => Promise<void> }>();
  /** sessionId → viewerId → state (viewers attached on THIS instance). */
  private readonly viewers = new Map<string, Map<string, ViewerState>>();
  /** sessionId → deviceId, for routing a local viewer's input. */
  private readonly sessionDevice = new Map<string, string>();
  /** On the device-holding instance: sessionId → instanceId → interest expiry. */
  private readonly remoteInterest = new Map<string, Map<string, number>>();
  /** On a viewer instance: the `cc:term:<id>` subscriptions it holds. */
  private readonly termSubs = new Map<string, () => Promise<void>>();

  constructor(opts: { instanceId: string; publish: PublishFn; subscribe: SubscribeFn; hooks?: RelayHooks }) {
    this.instanceId = opts.instanceId;
    this.publish = opts.publish;
    this.subscribe = opts.subscribe;
    this.hooks = opts.hooks ?? {};
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  hasLocalDevice(deviceId: string): boolean { return this.devices.has(deviceId); }

  /** A device connected here. A second connection for the same device replaces the first. */
  async attachDevice(deviceId: string, conn: RelayConn): Promise<void> {
    const prior = this.devices.get(deviceId);
    if (prior) { prior.conn.close(4000, 'replaced by a newer connection'); await prior.unsubscribe(); }
    const unsubscribe = await this.subscribe(`cc:dev:${deviceId}`, (payload) => this.onDeviceBus(deviceId, payload));
    this.devices.set(deviceId, { conn, unsubscribe });
  }

  async detachDevice(deviceId: string, conn: RelayConn): Promise<void> {
    const cur = this.devices.get(deviceId);
    if (!cur || cur.conn !== conn) return; // already replaced
    this.devices.delete(deviceId);
    await cur.unsubscribe();
  }

  /** Close a device's socket wherever it is (revocation). */
  async closeDevice(deviceId: string, reason: string): Promise<void> {
    const local = this.devices.get(deviceId);
    if (local) { local.conn.close(4001, reason); return; }
    await this.publish(`cc:dev:${deviceId}`, JSON.stringify({ type: 'close', reason } satisfies DevBus));
  }

  /** Route a control message to a device: local socket, else the bus. */
  async sendToDevice(deviceId: string, msg: DeviceControl): Promise<void> {
    const local = this.devices.get(deviceId);
    if (local) { local.conn.sendJson(msg); return; }
    await this.publish(`cc:dev:${deviceId}`, JSON.stringify(msg));
  }

  private onDeviceBus(deviceId: string, payload: string): void {
    const local = this.devices.get(deviceId);
    if (!local) return;
    let msg: DevBus;
    try { msg = JSON.parse(payload) as DevBus; } catch { return; }
    if (msg.type === 'interest') {
      const m = this.remoteInterest.get(msg.sessionId) ?? new Map<string, number>();
      m.set(msg.instanceId, Date.now() + INTEREST_TTL_MS);
      this.remoteInterest.set(msg.sessionId, m);
      return;
    }
    if (msg.type === 'close') { local.conn.close(4001, msg.reason); return; }
    local.conn.sendJson(msg);
  }

  /** A frame from a device socket held on THIS instance. */
  async onDeviceFrame(frame: DeviceFrame): Promise<void> {
    switch (frame.type) {
      case 'output':
        await this.emit(frame.sessionId, { k: 'o', d: frame.data });
        return;
      case 'replay':
        await this.emitReplay(frame.sessionId, frame.viewerId, Buffer.from(frame.data, 'base64'));
        return;
      case 'opened':
        this.hooks.onOpened?.(frame.sessionId);
        return;
      case 'exit':
        this.hooks.onExit?.(frame.sessionId, frame.code);
        await this.emit(frame.sessionId, { k: 'x', code: frame.code, requested: frame.requested });
        return;
      case 'error':
        await this.emit(frame.sessionId, { k: 'e', message: frame.message });
        return;
    }
  }

  private hasRemoteInterest(sessionId: string, now = Date.now()): boolean {
    const m = this.remoteInterest.get(sessionId);
    if (!m) return false;
    for (const [inst, exp] of m) if (exp <= now) m.delete(inst);
    if (m.size === 0) { this.remoteInterest.delete(sessionId); return false; }
    return true;
  }

  /** Deliver locally; publish (chunked) only when another instance is watching. */
  private async emit(sessionId: string, ev: TermEvent): Promise<void> {
    this.deliverLocal(sessionId, ev);
    if (!this.hasRemoteInterest(sessionId)) return;
    if (ev.k === 'o') {
      const raw = Buffer.from(ev.d, 'base64');
      for (let i = 0; i < raw.length; i += CHUNK_BYTES) {
        await this.publish(`cc:term:${sessionId}`, JSON.stringify({ k: 'o', d: raw.subarray(i, i + CHUNK_BYTES).toString('base64') } satisfies TermEvent));
      }
      return;
    }
    await this.publish(`cc:term:${sessionId}`, JSON.stringify(ev));
  }

  private async emitReplay(sessionId: string, viewerId: string, raw: Buffer): Promise<void> {
    const local = this.viewers.get(sessionId)?.get(viewerId);
    if (local) { this.completeReplay(local, raw); return; }
    // The viewer is on another instance: chunk it across the bus.
    if (raw.length === 0) {
      await this.publish(`cc:term:${sessionId}`, JSON.stringify({ k: 'r', v: viewerId, d: '', last: true } satisfies TermEvent));
      return;
    }
    for (let i = 0; i < raw.length; i += CHUNK_BYTES) {
      const last = i + CHUNK_BYTES >= raw.length;
      await this.publish(`cc:term:${sessionId}`, JSON.stringify({ k: 'r', v: viewerId, d: raw.subarray(i, i + CHUNK_BYTES).toString('base64'), last } satisfies TermEvent));
    }
  }

  // ── Viewers ──────────────────────────────────────────────────────────────

  /** A browser attached here. Asks the device for a replay, wherever the device is. */
  async attachViewer(sessionId: string, deviceId: string, conn: RelayConn): Promise<string> {
    const viewerId = `v_${randomBytes(6).toString('base64url')}`;
    const m = this.viewers.get(sessionId) ?? new Map<string, ViewerState>();
    m.set(viewerId, { conn, awaitingReplay: true, replayParts: [] });
    this.viewers.set(sessionId, m);
    this.sessionDevice.set(sessionId, deviceId);
    if (!this.devices.has(deviceId)) {
      if (!this.termSubs.has(sessionId)) {
        const unsub = await this.subscribe(`cc:term:${sessionId}`, (payload) => this.onTermBus(sessionId, payload));
        this.termSubs.set(sessionId, unsub);
      }
      await this.pingInterest(sessionId, deviceId);
    }
    await this.sendToDevice(deviceId, { type: 'attach', sessionId, viewerId });
    return viewerId;
  }

  async detachViewer(sessionId: string, viewerId: string): Promise<void> {
    const m = this.viewers.get(sessionId);
    m?.delete(viewerId);
    if (m && m.size === 0) {
      this.viewers.delete(sessionId);
      this.sessionDevice.delete(sessionId);
      const unsub = this.termSubs.get(sessionId);
      if (unsub) { this.termSubs.delete(sessionId); await unsub(); }
    }
  }

  /** Keystrokes / resize from a local viewer. */
  async viewerInput(sessionId: string, data: Buffer): Promise<void> {
    const deviceId = this.sessionDevice.get(sessionId);
    if (deviceId) await this.sendToDevice(deviceId, { type: 'input', sessionId, data: data.toString('base64') });
  }

  async viewerResize(sessionId: string, cols: number, rows: number): Promise<void> {
    const deviceId = this.sessionDevice.get(sessionId);
    if (deviceId) await this.sendToDevice(deviceId, { type: 'resize', sessionId, cols, rows });
  }

  /** Called on a timer: keep the device instance publishing for our remote viewers. */
  async refreshInterest(): Promise<void> {
    for (const sessionId of this.termSubs.keys()) {
      const deviceId = this.sessionDevice.get(sessionId);
      if (deviceId) await this.pingInterest(sessionId, deviceId);
    }
  }

  private async pingInterest(sessionId: string, deviceId: string): Promise<void> {
    await this.publish(`cc:dev:${deviceId}`, JSON.stringify({ type: 'interest', sessionId, instanceId: this.instanceId } satisfies DevBus));
  }

  private onTermBus(sessionId: string, payload: string): void {
    let ev: TermEvent;
    try { ev = JSON.parse(payload) as TermEvent; } catch { return; }
    if (ev.k === 'r') {
      const v = this.viewers.get(sessionId)?.get(ev.v);
      if (!v || !v.awaitingReplay) return;
      if (ev.d) v.replayParts.push(Buffer.from(ev.d, 'base64'));
      if (ev.last) { const all = Buffer.concat(v.replayParts); v.replayParts = []; this.completeReplay(v, all); }
      return;
    }
    this.deliverLocal(sessionId, ev);
  }

  private completeReplay(v: ViewerState, raw: Buffer): void {
    if (!v.awaitingReplay) return;
    v.awaitingReplay = false;
    if (raw.length) v.conn.sendBinary(raw);
  }

  private deliverLocal(sessionId: string, ev: TermEvent): void {
    const m = this.viewers.get(sessionId);
    if (!m) return;
    for (const v of m.values()) {
      if (ev.k === 'o') {
        if (v.awaitingReplay) continue; // these bytes are inside the replay on its way
        v.conn.sendBinary(Buffer.from(ev.d, 'base64'));
      } else if (ev.k === 'x') {
        v.conn.sendJson({ type: 'exit', code: ev.code, requested: ev.requested });
      } else if (ev.k === 'e') {
        v.conn.sendJson({ type: 'error', message: ev.message });
      }
    }
  }

  /** Counts, for caps and tests. */
  localViewerCount(sessionId?: string): number {
    if (sessionId) return this.viewers.get(sessionId)?.size ?? 0;
    let n = 0; for (const m of this.viewers.values()) n += m.size; return n;
  }
}
