/**
 * ADR 0814 — the wire tenantId is grammar-clean (no `~`, no `:`), injective,
 * idempotent and reversible, and every id this host already minted still
 * resolves (`identity.md` §5).
 *
 * ADR 0726 escaped `:` with RFC 0184's `~` (`user~3A<hex>`), which MINTED `~`
 * into every signed-in user's tenant-bound ids. No conformance leg saw it: the
 * conformance key lands in `default`, and the id regex admits `~` syntactically.
 * Tracker: TST-BVC-11.
 *
 * Red when (wave 60 probes w60g4-wt-*): a decoded new-form value need not be
 * canonical (aliases); a reserved wire prefix is accepted as an internal key
 * (here and in the leaf-module copy); a mapping mints `~`; ADR 0726's escaped
 * spelling stops decoding; an over-long key is accepted.
 */
import { describe, expect, it } from 'vitest';
import { fromWireTenant, toWireRunId, toWireTenant, wireTenantViolation } from '../src/host/v2Ids.js';
import { configuredTenantViolation } from '../src/middleware/apiKeyTenants.js';

const HASH = 'c51185914124375f328788edbc4a29f8';
const UUID = '0b6f2a3e-5d1c-4e8a-9f00-1a2b3c4d5e6f';
const OPAQUE = '8d365026-981a-4730-b416-8bfde6fc37ff';
const CLEAN = /^[A-Za-z0-9._-]{1,128}$/;

// Every internal key shape this host mints or is configured with.
const KEYS = ['default', 'conformance-prod', `user:${HASH}`, `ws:${UUID}`, 'org:acme', 'org:cjchain-1791162373478-0', 'anon:AbC-12_xyz', 'acme@corp.example'];

describe('ADR 0814 — the mapping', () => {
  it('maps each key shape to its row', () => {
    expect(toWireTenant('default')).toBe('default');
    expect(toWireTenant('conformance-prod')).toBe('conformance-prod');
    expect(toWireTenant('anon:AbC-12_xyz')).toBe('anon:AbC-12_xyz');
    expect(toWireTenant(`user:${HASH}`)).toBe(`u-${HASH}`);
    expect(toWireTenant(`ws:${UUID}`)).toBe(`w-${UUID}`);
    expect(toWireTenant('org:acme')).toBe('o-acme');
    expect(toWireTenant('acme@corp.example')).toBe(`x-${Buffer.from('acme@corp.example').toString('hex')}`);
  });

  it('never mints `~` or `:` (anon excepted: the corpus admits that prefix literally)', () => {
    for (const k of KEYS.filter((k) => !k.startsWith('anon:'))) expect(toWireTenant(k), k).toMatch(CLEAN);
    for (const k of KEYS) expect(toWireTenant(k), k).not.toContain('~');
  });

  it('is idempotent, so re-projecting a wire value cannot double-encode it', () => {
    for (const k of KEYS) expect(toWireTenant(toWireTenant(k)), k).toBe(toWireTenant(k));
  });

  it('round-trips, and is injective over the key shapes', () => {
    for (const k of KEYS) expect(fromWireTenant(toWireTenant(k)), k).toBe(k);
    expect(new Set(KEYS.map(toWireTenant)).size).toBe(KEYS.length);
  });

  it('a bound run id carries no `~` in its body form', () => {
    const id = toWireRunId(OPAQUE, `user:${HASH}`);
    expect(id).toBe(`u-${HASH}/${OPAQUE}`);
    expect(id).not.toContain('~');
  });
});

describe('ADR 0814 — ids already minted keep resolving (identity.md §5)', () => {
  it("ADR 0726's escaped spelling decodes to the same tenant", () => {
    expect(fromWireTenant(`user~3A${HASH}`)).toBe(`user:${HASH}`);
    expect(fromWireTenant(`ws~3A${UUID}`)).toBe(`ws:${UUID}`);
    expect(fromWireTenant('org~3Acjchain-1791162373478-0')).toBe('org:cjchain-1791162373478-0');
  });

  it('the raw internal key (what the SPA binds with) passes through', () => {
    expect(fromWireTenant(`user:${HASH}`)).toBe(`user:${HASH}`);
  });

  it('a `~` segment unescapes straight to the key, with no prefix dispatch', () => {
    expect(fromWireTenant('u~2Dabc')).toBe('u-abc');
  });

  it('one tenant has ONE new-form spelling (no aliases)', () => {
    const viaHex = `x-${Buffer.from(`user:${HASH}`).toString('hex')}`;
    expect(fromWireTenant(viaHex)).toBe(viaHex);
    expect(fromWireTenant(`U-${HASH}`)).toBe(`U-${HASH}`);
    expect(fromWireTenant(`x-${Buffer.from('acme@corp.example').toString('hex').toUpperCase()}`)).not.toBe('acme@corp.example');
  });
});

describe('ADR 0814 — the invariant injectivity rests on', () => {
  it('a key starting with a reserved wire prefix is not a legal internal key', () => {
    for (const k of ['u-abc', 'w-x', 'o-acme', 'x-00']) expect(wireTenantViolation(k), k).not.toBeNull();
  });

  it('every key shape this host mints satisfies it', () => {
    for (const k of KEYS) expect(wireTenantViolation(k), k).toBeNull();
  });

  it('a key too long to hex-encode within 128 is refused', () => {
    expect(wireTenantViolation(`team@${'a'.repeat(70)}`)).not.toBeNull();
  });

  it("apiKeyTenants' leaf-module copy of the rule agrees with the canonical one", () => {
    const samples = ['default', 'conformance-prod', 'acme@corp', 'u-abc', 'w-x', 'o-acme', 'x-00', '*', `t@${'a'.repeat(70)}`, `t-${'a'.repeat(120)}`];
    for (const t of samples) expect(configuredTenantViolation(t) === null, t).toBe(wireTenantViolation(t) === null);
  });
});
