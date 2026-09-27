/**
 * ADR 0552 P2 — what a peer's reply is allowed to become (invariant
 * `a2a-peer-no-authority-escalation`, named by RFC 0152 §E).
 *
 * `a2a-integration.md` §D.2 and §E, together: a peer's `metadata` is opaque,
 * both `ROLE_USER` and `ROLE_AGENT` content enters the run as
 * `contentTrust: "untrusted"` ("role never confers authority"), and
 * `referenceTaskIds[]` "MUST NOT grant read access to the referenced tasks …
 * and MUST NOT be dereferenced into prompt or tool context without a declared
 * mapping."
 *
 * The failure this prevents is specific and has a name in this corpus:
 * `prompt-injection-mcp-no-approval`, generalized to A2A. A peer answers with
 * text that reads like an approval, plus `metadata.openwop.approval: "accept"`,
 * plus a scope list, plus a task id it wants read. A host that treats any of it
 * as a decision has let a remote party approve its own request.
 *
 * {@link ingestPeerReply} is the production ingestion — the ONLY thing this
 * host does with a peer's answer. It returns text. It does not resolve
 * interrupts, does not touch `run.configurable`, does not fetch a referenced
 * task. That is the whole defence, and it is a defence by construction rather
 * than by filtering: there is no branch here that could act on peer metadata,
 * so there is no allowlist to keep correct.
 *
 * {@link extractPeerAssertions} exists only so a WITNESS can prove the peer
 * actually asserted something (`a2a-peer-authority.test.ts` is vacuous against
 * a peer that asserted nothing). Nothing in the ingestion path calls it.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §D.2, §E
 */

/** What a peer CLAIMED. Read by the §22 seam's witness; acted on by nothing. */
export interface PeerAssertions {
  /** `metadata.openwop.approval` — a decision the peer has no standing to make. */
  approval?: string;
  /** `metadata.openwop.scopes` — authority the peer proposes for itself. */
  scopes: readonly string[];
  /** `metadata.openwop.interrupt.resolve` — an interrupt resolution. */
  interruptResolve?: string;
  /** `referenceTaskIds[]` — ids the peer wants the host to read. */
  referenceTaskIds: readonly string[];
}

function messagesOf(reply: unknown): Array<Record<string, unknown>> {
  const r = (reply ?? {}) as { history?: unknown; task?: { history?: unknown } };
  const history = Array.isArray(r.history) ? r.history : Array.isArray(r.task?.history) ? r.task.history : [];
  return history.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object');
}

/** Collect every assertion a peer's reply carries. Diagnostic, never a decision. */
export function extractPeerAssertions(reply: unknown): PeerAssertions {
  const scopes: string[] = [];
  const referenceTaskIds: string[] = [];
  let approval: string | undefined;
  let interruptResolve: string | undefined;
  for (const m of messagesOf(reply)) {
    const refs = m.referenceTaskIds;
    if (Array.isArray(refs)) for (const id of refs) if (typeof id === 'string') referenceTaskIds.push(id);
    const ow = ((m.metadata ?? {}) as { openwop?: unknown }).openwop;
    if (ow === null || typeof ow !== 'object') continue;
    const o = ow as { approval?: unknown; scopes?: unknown; interrupt?: { resolve?: unknown } };
    if (typeof o.approval === 'string') approval = o.approval;
    if (Array.isArray(o.scopes)) for (const s of o.scopes) if (typeof s === 'string') scopes.push(s);
    if (typeof o.interrupt?.resolve === 'string') interruptResolve = o.interrupt.resolve;
  }
  return {
    ...(approval !== undefined ? { approval } : {}),
    scopes,
    ...(interruptResolve !== undefined ? { interruptResolve } : {}),
    referenceTaskIds,
  };
}

/** Everything a peer's reply may become inside this host. */
export interface IngestedPeerReply {
  /** The concatenated text of the peer's agent-role parts. */
  text: string;
  /** Always `'untrusted'` (§"Trust boundary"). Not a field a caller may set. */
  contentTrust: 'untrusted';
}

/**
 * The production ingestion of a peer's reply.
 *
 * Text only, `untrusted` always. `text` parts are read because that is what a
 * workflow consumes; `url` parts are NOT fetched (dereferencing is an RFC 0079
 * egress decision) and `raw` parts are NOT inlined (SR-1 / event-log bounds).
 * A `ROLE_AGENT` message is read exactly like a `ROLE_USER` one.
 */
export function ingestPeerReply(reply: unknown): IngestedPeerReply {
  const chunks: string[] = [];
  for (const m of messagesOf(reply)) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const p of parts) {
      if (p === null || typeof p !== 'object') continue;
      const text = (p as { text?: unknown }).text;
      if (typeof text === 'string') chunks.push(text);
    }
  }
  return { text: chunks.join('\n').trim(), contentTrust: 'untrusted' };
}
