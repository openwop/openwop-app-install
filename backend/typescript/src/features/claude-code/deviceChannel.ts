/**
 * ADR 1136 P2a — the paired-device channel, as a seam another feature can use
 * without reaching into the terminal relay.
 *
 * ADR 0785's companion holds ONE outbound socket per device. Terminals are one
 * use of it; ADR 1136's browser executor is another. This module lets a feature:
 *  - register a handler for a frame TYPE it owns, bound to the capability a
 *    device must hold to send it; and
 *  - send a message to a device, on whichever instance holds its socket.
 *
 * Release-manager conditions (ADR 1136 "P2 conditions"):
 *  1. A handler receives the socket's VERIFIED identity (device, tenant,
 *     person, capability), taken from the key the socket authenticated with.
 *     Nothing in the frame body can name a different device or person.
 *  3. Frames are typed, and a device whose capability does not match a frame
 *     type is refused, on receipt here and on send (`sendDeviceMessage`).
 */
import { createLogger } from '../../observability/logger.js';
import type { DeviceCapability } from './constants.js';
import type { DeviceRecord } from './pairingService.js';
import { deviceCapabilityOf } from './pairingService.js';

const log = createLogger('claude-code.device-channel');

/** Who sent a frame, from the socket's authentication. */
export interface DeviceIdentity {
  deviceId: string;
  tenantId: string;
  subject: string;
  capability: DeviceCapability;
}

export type DeviceFrameHandler = (frame: Record<string, unknown>, who: DeviceIdentity) => Promise<void> | void;

interface Registered { capability: DeviceCapability; handler: DeviceFrameHandler }

const handlers = new Map<string, Registered>();

/** Frame types a feature may own. The terminal's own types stay with the relay. */
const FEATURE_FRAME = /^[a-z]+-[a-z-]{1,40}$/;

export function registerDeviceFrameHandler(type: string, capability: DeviceCapability, handler: DeviceFrameHandler): void {
  if (!FEATURE_FRAME.test(type)) throw new Error(`device frame type "${type}" must be "<feature>-<name>"`);
  handlers.set(type, { capability, handler });
}

/** True when a registered handler owns this frame type (the socket then hands
 *  the frame here instead of to the terminal relay). */
export function ownsDeviceFrame(type: unknown): type is string {
  return typeof type === 'string' && handlers.has(type);
}

/** Called by the device socket with the verified identity. A capability
 *  mismatch is dropped and logged, never delivered. */
export async function dispatchDeviceFrame(frame: Record<string, unknown>, who: DeviceIdentity): Promise<void> {
  const r = handlers.get(String(frame.type));
  if (!r) return;
  if (who.capability !== r.capability) {
    log.warn('device_frame_capability_refused', { type: frame.type, deviceId: who.deviceId, capability: who.capability });
    return;
  }
  await r.handler(frame, who);
}

/** The identity a socket's device record gives. */
export function identityOf(d: Pick<DeviceRecord, 'deviceId' | 'tenantId' | 'subject' | 'capability'>): DeviceIdentity {
  return { deviceId: d.deviceId, tenantId: d.tenantId, subject: d.subject, capability: deviceCapabilityOf(d) };
}

/** Send a feature message to a device, on whichever instance holds it. Refuses
 *  a device whose capability is not `capability` (the send-side check). */
export async function sendDeviceMessage(device: Pick<DeviceRecord, 'deviceId' | 'capability' | 'revokedAt'>, capability: DeviceCapability, msg: { type: string } & Record<string, unknown>): Promise<boolean> {
  if (device.revokedAt || deviceCapabilityOf(device) !== capability || !FEATURE_FRAME.test(msg.type)) return false;
  const { getRelay } = await import('./terminalSockets.js');
  await getRelay().sendFeatureMessage(device.deviceId, msg);
  return true;
}
