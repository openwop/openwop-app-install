/**
 * ADR 0553 P3 — the MCP decision audit record, and the CLOSED key set.
 *
 * The ADR asks for "method, server/tool/resource identifier, principal,
 * outcome, duration and trace id; never arguments, content or bearer tokens by
 * default". Both halves are the requirement, and the second is the one a test
 * has to hold, because an MCP refusal is the single most tempting place to log
 * "why" in full — the token that had the wrong audience, the arguments the peer
 * sent, the content it returned. Every one of those is a credential or
 * attacker-controlled text, and the audit chain is durable and append-only:
 * there is no un-writing it.
 *
 * So the payload key set is pinned exactly, the way
 * `compensation-operator.test.ts` pins `authorizationDecided`'s five RFC 0049
 * keys. `toEqual` on a sorted key list, not `toMatchObject` — a subset
 * assertion is precisely the one that cannot notice a NEW field, which is the
 * only direction this test exists to guard.
 *
 * @see docs/adr/0553-mcp-2026-secure-versioned-adapter.md § "Authentication first"
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_KIND_MCP_DECIDED,
  MCP_AUDIT_OUTCOMES,
  MCP_AUDIT_PAYLOAD_KEYS,
  MCP_AUDIT_REASONS,
  mcpAuditTarget,
  recordMcpAudit,
} from '../src/host/mcpAudit.js';
import { listChain } from '../src/host/auditChainService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const TENANT = 'audit-tenant';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

async function rowsFor(tenantId: string): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
  const entries = await listChain(tenantId);
  return entries
    .filter((e) => e.kind === AUDIT_KIND_MCP_DECIDED)
    .map((e) => ({ kind: e.kind, payload: e.payload as Record<string, unknown> }));
}

describe('ADR 0553 P3 — the MCP audit record', () => {
  it('writes ONE row carrying EXACTLY the closed key set', async () => {
    const tenant = `${TENANT}-closed`;
    await recordMcpAudit({
      tenantId: tenant,
      direction: 'outbound',
      method: 'tools/call',
      target: mcpAuditTarget('acme-mcp', 'search'),
      principal: 'user-1',
      outcome: 'audience_refused',
      reason: 'audience_mismatch',
      durationMs: 12,
    });
    const rows = await rowsFor(tenant);
    expect(rows).toHaveLength(1);
    // EXACT, not a subset. A `toMatchObject` here would pass with `arguments`,
    // `token`, or the peer's content added — the only regression this leg exists
    // to catch.
    expect(Object.keys(rows[0]!.payload).sort()).toEqual([...MCP_AUDIT_PAYLOAD_KEYS].sort());
  });

  it('the closed set is DERIVED from the module, and the module is what the writer uses', async () => {
    // The restatement trap: a test that hard-coded the eight names would agree
    // with a drifted writer for as long as the drift existed. Both sides read
    // `MCP_AUDIT_PAYLOAD_KEYS`, so the assertion above compares the WRITER's
    // output to the DECLARED contract — and this leg pins the contract's own
    // content so the declaration cannot be quietly widened either.
    expect([...MCP_AUDIT_PAYLOAD_KEYS].sort()).toEqual([
      'direction', 'durationMs', 'method', 'outcome', 'principal', 'reason', 'target', 'traceId',
    ]);
    for (const forbidden of ['arguments', 'args', 'content', 'token', 'authorization', 'secret', 'requestState', 'bearer']) {
      expect(MCP_AUDIT_PAYLOAD_KEYS as readonly string[], `an MCP audit row must never carry '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it('records the ADR-named facts with the values it was given', async () => {
    const tenant = `${TENANT}-values`;
    await recordMcpAudit({
      tenantId: tenant,
      direction: 'inbound',
      method: 'tools/list',
      target: mcpAuditTarget('mount'),
      principal: 'anonymous',
      outcome: 'unauthenticated',
      reason: 'anonymous_principal',
      durationMs: 3.7,
    });
    const [row] = await rowsFor(tenant);
    expect(row!.payload).toMatchObject({
      direction: 'inbound',
      method: 'tools/list',
      target: 'mount',
      principal: 'anonymous',
      outcome: 'unauthenticated',
      reason: 'anonymous_principal',
      durationMs: 4, // rounded — a duration is a measurement, not a float to preserve
    });
    expect(typeof row!.payload.traceId).toBe('string');
  });

  it('a long tool name cannot inflate a row — a peer does not choose how big an audit entry is', async () => {
    const tenant = `${TENANT}-bounded`;
    const huge = 'x'.repeat(10_000);
    await recordMcpAudit({
      tenantId: tenant,
      direction: 'outbound',
      method: 'tools/call',
      target: mcpAuditTarget('acme-mcp', huge),
      principal: 'user-1',
      outcome: 'version_refused',
      reason: 'unsupported_revision',
      durationMs: 1,
    });
    const [row] = await rowsFor(tenant);
    expect(String(row!.payload.target).length).toBeLessThan(300);
    expect(String(row!.payload.target).startsWith('acme-mcp/')).toBe(true);
  });

  it('a PEER-SUPPLIED method cannot inflate a row either', async () => {
    // `routes/mcp.ts` reads `method` straight off the JSON-RPC body on the
    // inbound path, so it is attacker-controlled — the same class as a tool
    // name, and it was NOT bounded until the H53 self-review caught the
    // doc-comment claiming it was "host vocabulary".
    const tenant = `${TENANT}-method`;
    await recordMcpAudit({
      tenantId: tenant, direction: 'inbound', method: 'm'.repeat(9_000), target: mcpAuditTarget('mount'),
      principal: 'p', outcome: 'version_refused', reason: 'unsupported_revision', durationMs: 1,
    });
    const [row] = await rowsFor(tenant);
    expect(String(row!.payload.method).length).toBeLessThan(200);
  });

  it('a negative duration is clamped rather than recorded', async () => {
    const tenant = `${TENANT}-clamp`;
    await recordMcpAudit({
      tenantId: tenant, direction: 'outbound', method: 'tools/call', target: mcpAuditTarget('s'),
      principal: 'p', outcome: 'cancelled', reason: 'run_cancelled', durationMs: -5,
    });
    const [row] = await rowsFor(tenant);
    expect(row!.payload.durationMs).toBe(0);
  });

  it('the outcome and reason vocabularies are CLOSED', async () => {
    // Both end up in a durable, un-rewritable chain, so an open string would let
    // a call site invent a value the readers of that chain have never seen.
    expect(MCP_AUDIT_OUTCOMES).toContain('allowed');
    expect(MCP_AUDIT_OUTCOMES).toContain('audience_refused');
    expect(MCP_AUDIT_OUTCOMES).toContain('downgrade_refused');
    expect(MCP_AUDIT_REASONS).toContain('audience_unreadable');
    expect(MCP_AUDIT_REASONS).toContain('pinned_profile_not_offered');
    expect(MCP_AUDIT_REASONS).toContain('header_absent_legacy_unserved');
    // Every reason a refusal path can emit must be nameable; a `reason` outside
    // the union is a compile error at the call site, which is the enforcement.
    expect(new Set(MCP_AUDIT_REASONS).size).toBe(MCP_AUDIT_REASONS.length);
    expect(new Set(MCP_AUDIT_OUTCOMES).size).toBe(MCP_AUDIT_OUTCOMES.length);
  });

  it('an audit-sink failure does NOT become an oracle — the decision stands', async () => {
    // `recordMcpAudit` swallows an append failure by design: a refusal that
    // turned into a 500 because the chain was down would be an availability
    // lever, and one that turned into a SUCCESS would be far worse. An empty
    // tenantId is the cheapest way to make the sink reject.
    await expect(recordMcpAudit({
      tenantId: '', direction: 'outbound', method: 'tools/call', target: 't',
      principal: 'p', outcome: 'allowed', reason: 'ok', durationMs: 1,
    })).resolves.toBeUndefined();
  });
});
