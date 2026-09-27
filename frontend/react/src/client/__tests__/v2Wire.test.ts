import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromWireRunId, unbindRunIds, isRunIdKey, normalizeErrorCode, isNotFoundCode, bindRunId, bindRunIdValue, projectBoundId, toWireRunId, rememberWireTenant, resetWireTenant } from '../v2Wire.js';

describe('v2Wire — the one seam between the major-2 wire and the v1-shaped SPA', () => {
  it('strips the tenant segment from a tenant-bound run id and leaves a bare id alone', () => {
    expect(fromWireRunId('default/8f2f3fcf-8cf9-4dd4-84b9-e3f18ef43cc5')).toBe('8f2f3fcf-8cf9-4dd4-84b9-e3f18ef43cc5');
    expect(fromWireRunId('8f2f3fcf-8cf9-4dd4-84b9-e3f18ef43cc5')).toBe('8f2f3fcf-8cf9-4dd4-84b9-e3f18ef43cc5');
    // Not the grammar: a short second segment is not an opaque id.
    expect(fromWireRunId('a/b')).toBe('a/b');
  });

  it('deep-unbinds every run-id key, including arrays and nested docs, and nothing else', () => {
    const wire = {
      runId: 't/aaaaaaaaaaaaaaaaaaaa',
      parentRunId: 't/bbbbbbbbbbbbbbbbbbbb',
      events: [{ runId: 't/cccccccccccccccccccc', type: 'node.completed', payload: { runIds: ['t/dddddddddddddddddddd'] } }],
      eventsUrl: 'https://h/runs/t%2Faaaaaaaaaaaaaaaaaaaa/events',
      metadata: { note: 't/eeeeeeeeeeeeeeeeeeee' }, // not a run-id key: untouched
    };
    const out = unbindRunIds(wire);
    expect(out.runId).toBe('aaaaaaaaaaaaaaaaaaaa');
    expect(out.parentRunId).toBe('bbbbbbbbbbbbbbbbbbbb');
    expect(out.events[0]!.runId).toBe('cccccccccccccccccccc');
    expect(out.events[0]!.payload.runIds).toEqual(['dddddddddddddddddddd']);
    expect(out.eventsUrl).toBe(wire.eventsUrl);
    expect(out.metadata.note).toBe('t/eeeeeeeeeeeeeeeeeeee');
  });

  it('mirrors the host: every property the v2 schemas type as ANY tenant-bound id kind is a bound-id key here (ADR 0723)', () => {
    // The backend derives its projected-key set by walking schemas/v2 for
    // `$ref: ids.schema.json#/$defs/<kind>` over all five tenant-bound kinds
    // (host/v2Ids.ts deriveRunIdKeys, ADR 0723). This walks the same vendored
    // files and asserts the SPA's predicate covers every key it finds — parity
    // by derivation, not by a hand list. Per-kind floors keep the walk honest:
    // a walk that found no interruptId key would be a broken read, not a
    // schema without one.
    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const keys = new Set<string>();
    const perKind = new Map<string, Set<string>>();
    const KIND_REF = /ids\.schema\.json#\/\$defs\/(runId|interruptId|subscriptionId|deliveryId|effectId)$/;
    const walk = (node: unknown, parentKey: string | undefined): void => {
      if (Array.isArray(node)) { for (const n of node) walk(n, parentKey); return; }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const ref = obj['$ref'];
      const m = typeof ref === 'string' ? KIND_REF.exec(ref) : null;
      if (m && parentKey) {
        keys.add(parentKey);
        if (!perKind.has(m[1]!)) perKind.set(m[1]!, new Set());
        perKind.get(m[1]!)!.add(parentKey);
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, ['properties', 'items', '$defs', 'allOf', 'anyOf', 'oneOf'].includes(k) ? parentKey : k);
      }
    };
    for (const f of readdirSync(root)) {
      if (!f.endsWith('.schema.json')) continue;
      walk(JSON.parse(readFileSync(join(root, f), 'utf8')), undefined);
    }
    expect(keys.size).toBeGreaterThan(0); // non-vacuous: the walk found the schemas
    for (const kind of ['runId', 'interruptId', 'subscriptionId', 'deliveryId', 'effectId']) {
      expect(perKind.get(kind)?.size ?? 0, `the walk found no key bound to ${kind} — a broken read, not a schema without one`).toBeGreaterThan(0);
    }
    // A key bound to two kinds would make ONE predicate ambiguous; none is today.
    const seen = new Map<string, string>();
    for (const [kind, ks] of perKind) for (const k of ks) { expect(seen.get(k) ?? kind, `${k} is bound to two kinds`).toBe(kind); seen.set(k, kind); }
    const uncovered = [...keys].filter((k) => !isRunIdKey(k));
    expect(uncovered, `bound-id keys the SPA would leave tenant-bound: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('opens the host\'s `vendor.openwop-app` carry box back onto the parent (ADR 0725 D3), nested too', () => {
    const wire = {
      type: 'conversation.opened',
      payload: { conversationId: 'c1', 'vendor.openwop-app': { initialTurn: { messageId: 'm0', turnIndex: 0 }, capabilities: ['multi-turn'] } },
      error: { code: 'x', message: 'y', 'vendor.openwop-app': { userMessage: 'Try again', runId: 'default/0123456789abcdef0123' } },
    };
    type Loose = Record<string, unknown>;
    const out = unbindRunIds(wire) as { payload: Loose; error: Loose };
    expect(out.payload).toEqual({ conversationId: 'c1', initialTurn: { messageId: 'm0', turnIndex: 0 }, capabilities: ['multi-turn'] });
    expect(out.error).toEqual({ code: 'x', message: 'y', userMessage: 'Try again', runId: '0123456789abcdef0123' });
    expect('vendor.openwop-app' in out.payload).toBe(false);
    // A seated key present beside the box wins over a boxed duplicate.
    const dup = unbindRunIds({ a: 'seated', 'vendor.openwop-app': { a: 'boxed', b: 1 } }) as Loose;
    expect(dup).toEqual({ a: 'seated', b: 1 });
    const dup2 = unbindRunIds({ 'vendor.openwop-app': { a: 'boxed', b: 1 }, a: 'seated' }) as Loose;
    expect(dup2).toEqual({ a: 'seated', b: 1 });
  });

  it('strips THIS host\'s vendor prefix from an error code and nothing else', () => {
    expect(normalizeErrorCode('openwop-app.approval_required')).toBe('approval_required');
    expect(normalizeErrorCode('rate_limited')).toBe('rate_limited');
    expect(normalizeErrorCode('other-org.something')).toBe('other-org.something');
  });

  it('treats the v2 not_found alias and both v1 spellings as not-found', () => {
    for (const c of ['not_found', 'run_not_found', 'workflow_not_found']) expect(isNotFoundCode(c)).toBe(true);
    expect(isNotFoundCode('forbidden')).toBe(false);
    expect(isNotFoundCode(null)).toBe(false);
  });

  it('binds a bare id to the tenant the wire last told us, without a lookup', async () => {
    resetWireTenant();
    fromWireRunId('acme/aaaaaaaaaaaaaaaaaaaa'); // remembers `acme`
    const loader = vi.fn(async () => ({ active: 'should-not-be-called' }));
    expect(await bindRunIdValue('bbbbbbbbbbbbbbbbbbbb', loader)).toBe('acme/bbbbbbbbbbbbbbbbbbbb');
    expect(loader).not.toHaveBeenCalled();
  });

  it('resolves the tenant ONCE from the host when nothing has told us yet, then reuses it', async () => {
    resetWireTenant();
    const loader = vi.fn(async () => ({ active: 'org-1' }));
    expect(await bindRunIdValue('bbbbbbbbbbbbbbbbbbbb', loader)).toBe('org-1/bbbbbbbbbbbbbbbbbbbb');
    expect(await bindRunIdValue('cccccccccccccccccccc', loader)).toBe('org-1/cccccccccccccccccccc');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a workspace switch re-binds: rememberWireTenant wins over the cached value', async () => {
    resetWireTenant();
    rememberWireTenant('org-1');
    rememberWireTenant('org-2');
    expect(await bindRunIdValue('bbbbbbbbbbbbbbbbbbbb', async () => ({ active: 'x' }))).toBe('org-2/bbbbbbbbbbbbbbbbbbbb');
    expect(toWireRunId('org-2/bbbbbbbbbbbbbbbbbbbb', 'org-9')).toBe('org-2/bbbbbbbbbbbbbbbbbbbb'); // already bound: untouched
  });

  it('bindRunId hands the SDK the ~-PROJECTED path form (RFC 0184), never a percent form, and a personal `user:` tenant projects too (ADR 0726)', async () => {
    rememberWireTenant('acme');
    expect(await bindRunId('bbbbbbbbbbbbbbbbbbbb', async () => ({ active: 'acme' }))).toBe('acme~2Fbbbbbbbbbbbbbbbbbbbb');
    rememberWireTenant('user:0123456789abcdef0123456789abcdef');
    const p = await bindRunId('bbbbbbbbbbbbbbbbbbbb', async () => ({ active: 'user:0123456789abcdef0123456789abcdef' }));
    expect(p).toBe('user~3A0123456789abcdef0123456789abcdef~2Fbbbbbbbbbbbbbbbbbbbb');
    expect(encodeURIComponent(p), 'all-unreserved: an intermediary cannot rewrite it').toBe(p);
    expect(projectBoundId('acme/r-1')).toBe('acme~2Fr-1');
    // A bound id the wire returned with a projected tenant reads as bound and unbinds to the bare opaque.
    expect(fromWireRunId('user~3A0123456789abcdef0123456789abcdef/bbbbbbbbbbbbbbbbbbbb')).toBe('bbbbbbbbbbbbbbbbbbbb');
  });

  it('restores a host-only interrupt kind carried as `custom` + boxed spelling (ADR 0725)', () => {
    const out = unbindRunIds({ type: 'node.suspended', payload: { interruptId: 'i', kind: 'custom', 'vendor.openwop-app': { kind: 'walkthrough-step' } } }) as { payload: Record<string, unknown> };
    expect(out.payload).toEqual({ interruptId: 'i', kind: 'walkthrough-step' });
    const seated = unbindRunIds({ kind: 'approval', 'vendor.openwop-app': { kind: 'x' } }) as Record<string, unknown>;
    expect(seated.kind, 'a seated non-custom kind is never overridden').toBe('approval');
  });
});
