/**
 * ADR 1043 CHAN-F11 (`RELAY-KILL-SWITCH-1`) — a workspace admin's kill switch for
 * ONE relay channel (say, WhatsApp only) in a workspace.
 *
 * Since ADR 1043 D9 the relay's conversation mode no longer needs an enabled
 * messaging connector, so the only controls were the `channel-ingress` toggle
 * (every lane, every channel) and revoking devices one by one. With a channel
 * switched off, every relay device of that channel in the workspace:
 *  - has its inbound messages acknowledged and dropped BEFORE any budget, claim or
 *    delivery-log row (`device/inbound`), in both conversation and workflow mode;
 *  - pulls no outbound (`device/outbound` answers an empty list with `paused`), and
 *    nothing new is queued for it (`enqueueOutbound` refuses `relay_channel_disabled`);
 *    egress already queued waits, and ages out at the token lifetime (CHAN-F12) if
 *    the channel stays off;
 *  - fails closed (a retryable 503) if the switch cannot be read;
 *  - keeps heartbeating and keeps its token, approvals and settings, so switching
 *    the channel back on resumes it without re-pairing.
 *
 * One row per workspace, no person in it (who changed it is the route's audit
 * line), so the store is EXEMPT from subject erasure and goes with tenant teardown.
 */
import { DurableCollection } from '../host/hostExtPersistence.js';
import { RELAY_CHANNELS, type RelayChannel } from './types.js';
import { OpenwopError } from '../types.js';

interface RelayChannelSwitchRow { tenantId: string; disabledChannels: RelayChannel[]; updatedAt: string }

const switches = new DurableCollection<RelayChannelSwitchRow>('messaging:relay-channel-switch', (r) => r.tenantId, undefined, (r) => r.tenantId);

/** The channels switched off in this workspace (none by default). */
export async function disabledRelayChannels(tenantId: string): Promise<RelayChannel[]> {
  const row = await switches.get(tenantId);
  return row && row.tenantId === tenantId ? [...row.disabledChannels] : [];
}

/** Is this channel's relay switched off in this workspace?
 *
 *  Fails CLOSED, without losing anything, on a read error: it throws a retryable 503
 *  (`service_unavailable`). A kill switch is flipped when a channel is
 *  being abused, so a storage blip must not re-open it; and a 503 (not a drop) makes
 *  the device retry the inbound message or the pull, and the sender retry the enqueue,
 *  so nothing is lost while the read is failing. */
export async function relayChannelDisabled(tenantId: string, channel: RelayChannel): Promise<boolean> {
  try {
    return (await disabledRelayChannels(tenantId)).includes(channel);
  } catch {
    throw new OpenwopError('service_unavailable', 'The relay channel switch could not be read; retry.', 503);
  }
}

/** Switch one channel on or off. Compare-and-swap, so two admins switching two
 *  channels at once both land. Returns the channels now off. */
export async function setRelayChannelEnabled(tenantId: string, channel: RelayChannel, enabled: boolean): Promise<RelayChannel[]> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const cur = await switches.get(tenantId);
    const off = new Set(cur?.disabledChannels ?? []);
    if (enabled) off.delete(channel); else off.add(channel);
    const disabledChannels = RELAY_CHANNELS.filter((c) => off.has(c));
    const next: RelayChannelSwitchRow = { tenantId, disabledChannels, updatedAt: new Date().toISOString() };
    if (await switches.compareAndSwap(cur, next)) return disabledChannels;
  }
  throw new Error('relay channel switch: too much contention');
}
