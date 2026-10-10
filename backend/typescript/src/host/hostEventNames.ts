/**
 * ADR 0792 (NP-V2-10) — the ONE owner of how this host's HOST-EVENT names are
 * spelled on the v2 wire.
 *
 * WHY. Host events (ADR 0208 `emitHostEvent`) have always been named
 * `host.<feature>.<entity>.<verb>` — four segments, under the org `host`. The v2
 * vendor-event grammar (`spec/v2/core/events.md` §Types) allows two or three
 * kebab segments whose FIRST is an org registered in `spec/v2/declaration.json`;
 * `host` is not registered, so every one of them (MEASURED: ~162 four-segment
 * names, 8 three-segment `host.*`, and `crm.segment.entered`) was invalid on a
 * major-2 webhook body.
 *
 * THE DECISION (option C). In process, the host keeps emitting its v1 dialect —
 * the same rule ADR 0722 set for run events ("the in-process event stays in the
 * host's v1 dialect"). A major-2 subscriber receives the projected, grammar-
 * valid spelling; a major-1 subscriber is byte-identical to before. Nothing
 * stored is rewritten: matching compares the EMITTED name's spellings against
 * whatever a subscription or binding registered, so either spelling subscribes.
 *
 * THE MAPPING, deterministic:
 *   host.<a>.<b>.<c>   → openwop-app.<a>.<b>-<c>
 *   host.<a>.<b>       → openwop-app.<a>.<b>
 *   crm.segment.entered → openwop-app.crm.segment-entered
 * A name already under `openwop-app.` (ADR 0674's renames) is returned as-is,
 * and anything else is not a host event and is returned unchanged.
 *
 * It must be INJECTIVE over the names this host emits — two host events must
 * never share a v2 spelling, or a v2 subscriber could not tell them apart.
 * `test/host-event-names.test.ts` enforces that over every emitted name.
 */

import { eventTypeSpellings, wireEventType } from '../storage/eventEra.js';

/** The org every host event is projected under on the v2 wire. */
export const HOST_EVENT_ORG = 'openwop-app';

const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Legacy names under an unregistered org other than `host`. Closed list. */
const LEGACY_OTHER: ReadonlyMap<string, string> = new Map([
  ['crm.segment.entered', `${HOST_EVENT_ORG}.crm.segment-entered`],
]);

/**
 * The v2 spelling of a host event, or `null` when `type` is not a host event
 * this module owns (a protocol type, another vendor's, or a malformed name).
 */
export function v2HostEventType(type: string): string | null {
  const other = LEGACY_OTHER.get(type);
  if (other !== undefined) return other;
  if (type.startsWith(`${HOST_EVENT_ORG}.`)) return type;
  if (!type.startsWith('host.')) return null;
  const parts = type.split('.').slice(1);
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  if (parts.length === 2) return `${HOST_EVENT_ORG}.${parts[0]}.${parts[1]}`;
  if (parts.length === 3) return `${HOST_EVENT_ORG}.${parts[0]}.${parts[1]}-${parts[2]}`;
  return null;
}

/**
 * Every spelling a subscription or binding may have registered for one EMITTED
 * host event: the in-process name plus its v2 spelling. A non-host type yields
 * just itself, so callers can union this with the run-event spellings.
 */
export function hostEventTypeSpellings(type: string): ReadonlySet<string> {
  const v2 = v2HostEventType(type);
  return v2 === null || v2 === type ? new Set([type]) : new Set([type, v2]);
}

/** A grammar-valid v2 host-event name under this host's org (2 or 3 segments). */
const V2_HOST_NAME = new RegExp(`^${HOST_EVENT_ORG.replace(/-/g, '\\-')}(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*){1,2}$`);
export function isV2HostEventName(type: string): boolean {
  return V2_HOST_NAME.test(type);
}

/**
 * The major-2 wire type for ANY outbound event — run event or host event — with
 * ONE precedence: the run-event codemap (incl. HOST_VENDOR_ROWS) wins, and the
 * host-event rule applies only to a type the codemap does not know. Without the
 * precedence the RUN event `host.webhook.response` would leave on a v2 webhook
 * as `openwop-app.webhook.response` while a v2 poll of the same event reads
 * `openwop-app.webhook-response` (review of ADR 0792).
 */
export function v2WireEventType(type: string): string {
  const codemapped = wireEventType(type, 2);
  if (codemapped !== type) return codemapped;
  return v2HostEventType(type) ?? type;
}

/** Every spelling a subscription may carry for one emitted type, same precedence. */
export function wireEventTypeSpellings(type: string): ReadonlySet<string> {
  const run = eventTypeSpellings(type);
  return run.size > 1 ? run : hostEventTypeSpellings(type);
}
