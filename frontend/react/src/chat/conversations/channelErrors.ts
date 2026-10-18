/**
 * CH2UX-5 (ADR 0879) — say WHY a channel write was refused.
 *
 * ADR 0879 added three refusals a person can actually act on, and every channel
 * surface collapsed them into one generic "Something went wrong":
 *
 *  - `forbidden_scope` (D1) — the caller's workspace role reads but does not write;
 *  - `details.code === 'channel_managers_only'` (D8) — an announcement channel;
 *  - a 404 carrying `details.userId` (D4) — the person is no longer in the workspace.
 *
 * Anything else keeps the caller's own fallback copy. Keys are namespace-qualified (`chat:`). Pure: takes the error and a
 * translator, so it is testable without rendering.
 */
type Translate = (key: string) => string;

/** The fields `ChannelRequestError` (client/channelsClient.ts) carries. Read
 *  structurally, NOT via `instanceof`, so the chat entry chunk does not have to
 *  import the lazily-loaded client just to classify an error. */
interface RefusalShape { status?: unknown; code?: unknown; details?: { code?: unknown; userId?: unknown } }

export function channelErrorCopy(err: unknown, t: Translate, fallbackKey: string): string {
  if (err !== null && typeof err === 'object') {
    const e = err as RefusalShape;
    if (e.code === 'forbidden_scope') return t('chat:channelWriteForbidden');
    if (e.details?.code === 'channel_managers_only') return t('chat:channelReadOnlyComposer');
    if (e.status === 404 && typeof e.details?.userId === 'string') return t('chat:channelMemberNotInWorkspace');
  }
  return t(fallbackKey);
}
