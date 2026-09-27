/**
 * `peers` namespace — the A2A peers panel: an honest not-yet-available state
 * (contributor context lives in the component's comment, not user copy).
 */
export const messages = {
  title: 'A2A peers',
  notAvailableTitle: 'Agent-to-agent connections are not available on this host yet',
  notAvailableBody: 'Agent2Agent (A2A) lets workflows on this host be called by — and dispatch into — remote agent platforms. This deployment does not advertise the capability yet; peers will appear here once it does.',
} as const;
