/**
 * ADR 1136 P2a — a `BrowserExecutor` that is the person's own paired browser
 * device, reached over the ADR 0785 device channel, from any instance.
 *
 * Routing (P2 entry criterion 1). An operation goes to the device's socket on
 * whichever instance holds it (`sendDeviceMessage`). The device answers on that
 * socket. The holding instance hands the result to a waiter in this process,
 * or publishes it on `cu:res:<reqId>`, which the requesting instance subscribed
 * to before sending. Published results are chunked under Postgres NOTIFY's
 * 8000-byte payload limit.
 *
 * Binding (condition 2). Each request id is 16 random bytes. A result is applied
 * only when its tenant (from the device socket's verified identity), its
 * executor and its binding id all match the pending request; a mismatch is
 * dropped and logged. A result that arrives after its operation timed out is
 * dropped, never applied: a timed-out operation is never replayed.
 *
 * Typing (condition 3). Every operation frame names its kind, and is sent only
 * to a device paired with the `browser` capability.
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { publishHostExtEvent, subscribeHostExtEvent } from '../../host/hostExtPersistence.js';
import { isDeviceOnline } from '../claude-code/terminalStore.js';
import { ownedDevice } from '../claude-code/pairingService.js';
import { registerDeviceFrameHandler, sendDeviceMessage, type DeviceIdentity } from '../claude-code/deviceChannel.js';
import { browserPresenceFor, recordBrowserAttach, recordBrowserDetach } from './browserPresence.js';
import { EXECUTOR_PROTOCOL_VERSION, parseControlFrame, type BrowserExecutor, type ExecutorOp } from './executorProtocol.js';

const log = createLogger('computer-use.remote-executor');

/** Raw characters per published part, well under the 8000-byte NOTIFY limit. */
export const RESULT_CHUNK_CHARS = 6_000;

export type PublishFn = (channel: string, payload: string) => Promise<void>;
export type SubscribeFn = (channel: string, handler: (payload: string) => void) => Promise<() => Promise<void>>;
export type SendFn = typeof sendDeviceMessage;

interface Pending {
  tenantId: string;
  executorId: string;
  bindingId: string;
  resolve: (raw: unknown) => void;
}

interface ResultPart { tenantId: string; executorId: string; bindingId: string; i: number; n: number; d: string }

/** Per-process state: the waiters, and the transport (injectable for a
 *  two-instance test). */
export class RemoteExecutorHub {
  private readonly pending = new Map<string, Pending>();
  constructor(
    readonly publish: PublishFn = publishHostExtEvent,
    readonly subscribe: SubscribeFn = subscribeHostExtEvent,
    readonly send: SendFn = sendDeviceMessage,
  ) {}

  /** A result frame from a device socket on THIS instance. */
  async onResultFrame(frame: Record<string, unknown>, who: DeviceIdentity): Promise<void> {
    const reqId = frame.reqId;
    const executorId = frame.executorId;
    const bindingId = frame.bindingId;
    if (typeof reqId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(reqId) || typeof executorId !== 'string' || typeof bindingId !== 'string') return;
    const local = this.pending.get(reqId);
    if (local) { this.settle(reqId, { tenantId: who.tenantId, executorId, bindingId }, frame.result); return; }
    const text = JSON.stringify(frame.result ?? null);
    const n = Math.max(1, Math.ceil(text.length / RESULT_CHUNK_CHARS));
    for (let i = 0; i < n; i += 1) {
      const part: ResultPart = { tenantId: who.tenantId, executorId, bindingId, i, n, d: text.slice(i * RESULT_CHUNK_CHARS, (i + 1) * RESULT_CHUNK_CHARS) };
      await this.publish(`cu:res:${reqId}`, JSON.stringify(part));
    }
  }

  /** Apply a result only to the request it belongs to (condition 2). */
  private settle(reqId: string, from: { tenantId: string; executorId: string; bindingId: string }, raw: unknown): void {
    const p = this.pending.get(reqId);
    if (!p) return; // timed out already: dropped, never applied
    if (p.tenantId !== from.tenantId || p.executorId !== from.executorId || p.bindingId !== from.bindingId) {
      log.warn('browser_result_binding_mismatch', { reqId });
      return;
    }
    this.pending.delete(reqId);
    p.resolve(raw);
  }

  /** Send one operation and wait for its bound result. */
  async request(input: {
    device: { deviceId: string; capability?: 'terminal' | 'browser'; revokedAt?: string };
    tenantId: string; executorId: string; bindingId: string; op: ExecutorOp; timeoutMs: number;
  }): Promise<unknown> {
    const reqId = randomBytes(16).toString('base64url');
    const parts: string[] = [];
    let unsubscribe: (() => Promise<void>) | null = null;
    const done = new Promise<unknown>((resolve) => {
      this.pending.set(reqId, { tenantId: input.tenantId, executorId: input.executorId, bindingId: input.bindingId, resolve });
    });
    try {
      unsubscribe = await this.subscribe(`cu:res:${reqId}`, (payload) => {
        let part: ResultPart;
        try { part = JSON.parse(payload) as ResultPart; } catch { return; }
        if (!Number.isInteger(part.i) || !Number.isInteger(part.n) || part.n < 1 || part.n > 200 || part.i < 0 || part.i >= part.n) return;
        parts[part.i] = part.d;
        if (parts.filter((x) => typeof x === 'string').length !== part.n) return;
        let raw: unknown;
        try { raw = JSON.parse(parts.join('')); } catch { raw = undefined; }
        this.settle(reqId, part, raw);
      });
      const sent = await this.send(input.device, 'browser', {
        type: 'browser-op', reqId, executorId: input.executorId, bindingId: input.bindingId, kind: input.op.op, op: input.op,
      });
      if (!sent) { this.pending.delete(reqId); return { ok: false, error: 'detached' }; }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<unknown>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), input.timeoutMs); });
      const out = await Promise.race([done, timeout]);
      if (timer) clearTimeout(timer);
      return out;
    } finally {
      this.pending.delete(reqId);
      if (unsubscribe) await unsubscribe().catch(() => undefined);
    }
  }

  /** Test seam: waiters in flight. */
  pendingCount(): number { return this.pending.size; }
}

let hub = new RemoteExecutorHub();
export function remoteExecutorHub(): RemoteExecutorHub { return hub; }
/** Test seam: run with an injected transport. */
export function _setRemoteExecutorHub(h: RemoteExecutorHub): void { hub = h; }

/**
 * The person's attached browser as an executor, or null when none is attached
 * or its device is offline, revoked, or not a browser device. Re-reads presence
 * on every operation, so a newer attach makes this one `replaced`.
 */
export async function remoteExecutorFor(tenantId: string, subject: string): Promise<BrowserExecutor | null> {
  const p = await browserPresenceFor(tenantId, subject);
  if (!p) return null;
  const device = await ownedDevice(tenantId, p.deviceId, subject);
  if (!device || (device.capability ?? 'terminal') !== 'browser' || !(await isDeviceOnline(device.deviceId))) return null;
  const executorId = p.executorId;
  const bindingId = randomBytes(12).toString('base64url');
  let state: 'attached' | 'replaced' | 'detached' = 'attached';
  return {
    executorId,
    protocolVersion: p.protocolVersion,
    state: () => state,
    markReplaced() { state = 'replaced'; },
    async perform(op, opts) {
      const now = await browserPresenceFor(tenantId, subject);
      if (!now || now.deviceId !== device.deviceId) { state = 'detached'; return { ok: false, error: 'detached' }; }
      if (now.executorId !== executorId) { state = 'replaced'; return { ok: false, error: 'replaced' }; }
      if (!(await isDeviceOnline(device.deviceId))) { state = 'detached'; return { ok: false, error: 'detached' }; }
      return hub.request({ device, tenantId, executorId, bindingId, op, timeoutMs: opts.timeoutMs });
    },
  };
}

let registered = false;

/** Wire the three browser frame types into the device channel. A browser
 *  device sends them; any other device is refused by the channel. */
export function registerBrowserDeviceHandlers(): void {
  if (registered) return;
  registered = true;
  registerDeviceFrameHandler('browser-attach', 'browser', async (frame, who) => {
    // Ids only (condition 1): exactly type, executorId, protocolVersion. The
    // device, tenant and person come from `who`, never from the frame.
    const { type: _t, ...rest } = frame;
    const control = parseControlFrame({ type: 'attach', ...rest });
    if (!control || control.type !== 'attach') { log.warn('browser_attach_refused', { deviceId: who.deviceId }); return; }
    await recordBrowserAttach({
      tenantId: who.tenantId, subject: who.subject, deviceId: who.deviceId,
      executorId: control.executorId, protocolVersion: EXECUTOR_PROTOCOL_VERSION, attachedAt: new Date().toISOString(),
    });
  });
  registerDeviceFrameHandler('browser-detach', 'browser', async (frame, who) => {
    const { type: _t, ...rest } = frame;
    const control = parseControlFrame({ type: 'detach', ...rest });
    if (!control) return;
    await recordBrowserDetach(who.tenantId, who.subject, who.deviceId, control.executorId);
  });
  registerDeviceFrameHandler('browser-result', 'browser', (frame, who) => hub.onResultFrame(frame, who));
}
