/**
 * CHAN-F1 (ADR 1042 open items) — the connections broker withholds every
 * connection from an acting human who has LEFT the shared workspace the run is
 * in. Before this, only an org-shared connection was re-checked (through
 * `connections:use`); a scheduled run, a heartbeat or a resumed run stamped with
 * a departed member still drew their personal connection and the workspace's.
 *
 * Red when: `actingUserPresent` is dropped from `authorizedCandidates` (legs 2
 * and 3 resolve the departed member's own and the workspace's credential), when
 * it skips the pinned lane (leg 3), or when it is widened past people and shared
 * workspaces (legs 4 and 5: an actor-less send, a non-person actor and a
 * personal tenant must resolve exactly as before), or when the `apikey:` branch
 * stops asking for its issuer (leg 6: a departed issuer's key, a key bound to
 * another tenant and an unknown key all resolve nothing).
 *
 * Widened 2026-11-07 (David's decision) to the ADR 0910 declared default
 * workspaces, membership only. Red when the gate goes back to `ws:`-only (legs
 * D1, D2b, D3 and D4b resolve again), or when a live operator activation is
 * read as presence (legs D2b and D3: a removed operator and a never-member, each
 * with a LIVE activation, must resolve nothing). Leg D2a holds the other side:
 * an operator who activated is a member through the activation's participant
 * row, and keeps working. Leg D6: a delegation that vanishes between the
 * issuer check and the issuer lookup must fail closed (red on `?? ''`).
 *
 * Two claims are held by more than one line, so a one-line probe on either
 * reads vacuous (w96, measured):
 *   - actor-less sends (legs 4 and D5): `actingUserPresent`'s `!actingUserId`
 *     early return AND the non-person return (`PERSON_SUBJECT.test(undefined)`
 *     is false). A double guard in one function, witnessed by a break-both probe.
 *   - "a live activation is not presence" (legs D2b, D3) is held structurally:
 *     nothing on this path reads `operatorActivations`. A stand-in sabotage that
 *     grants presence to those subjects reds both legs.
 *
 * Every leg owns its members, so the file passes in any order (w96: legs 1-3
 * used to share one member that leg 2 removed, and went red under shuffle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const { openSqliteStorage } = await import('../src/storage/sqlite/index.js');
const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { configureSecretResolver } = await import('../src/byok/secretResolver.js');
const { createWorkspace, createMember, createOrg, deleteMember, registerMembershipRootedWorkspaces } = await import('../src/host/accessControlService.js');
const { isActivationLive, operatorActivations } = await import('../src/host/operatorActivationLedger.js');
const { createSecretConnection, resolveConnectionCredential } = await import('../src/features/connections/connectionsService.js');
const { registerDelegationLookup } = await import('../src/host/delegatedSubject.js');

const storage = openSqliteStorage(':memory:');
const FIXED = { fixedEndpoint: 'test: selection only' } as const;
let WS = '';

beforeAll(async () => {
  initHostExtPersistence(storage);
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-chan-f1-')) });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'CHAN-F1 workspace', ownerSubject: 'user:f1-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createSecretConnection({ tenantId: WS, provider: 'telegram', kind: 'bearer', secret: '1:workspace', scope: 'workspace' });
});
afterAll(async () => { registerDelegationLookup(async () => null); _resetKmsForTesting(); __resetHostExtPersistence(); await storage.close(); });

/** A current member of the shared workspace with their own connection (one per leg). */
async function memberWithConnection(name: string): Promise<{ subject: string; memberId: string; connectionId: string; secret: string }> {
  const subject = `user:f1-${name}`;
  const secret = `1:${name}`;
  const { memberId } = await createMember({ orgId: WS, tenantId: WS, displayName: name, subject, roles: ['editor'] });
  const { connectionId } = await createSecretConnection({ tenantId: WS, provider: 'telegram', kind: 'bearer', secret, scope: 'user', userId: subject });
  return { subject, memberId, connectionId, secret };
}

const secretOf = async (input: { tenantId: string; actingUserId?: string; connectionId?: string }): Promise<string | null> =>
  (await resolveConnectionCredential({ egress: FIXED, provider: 'telegram', ...input }))?.secret ?? null;

describe('CHAN-F1 — a departed member draws no connection in a shared workspace', () => {
  it('leg 1: a current member resolves their own connection', async () => {
    expect(WS.startsWith('ws:'), 'the fixture must be a shared workspace').toBe(true);
    const alice = await memberWithConnection('alice');
    expect(await secretOf({ tenantId: WS, actingUserId: alice.subject })).toBe('1:alice');
  });

  it('leg 2: once removed, they get neither their own connection nor the workspace\'s', async () => {
    const amy = await memberWithConnection('amy');
    expect(await secretOf({ tenantId: WS, actingUserId: amy.subject }), 'present before removal').toBe('1:amy');
    expect(await deleteMember(amy.memberId)).toBe(true);
    expect(await secretOf({ tenantId: WS, actingUserId: amy.subject }), 'no fall-through to the workspace row either').toBeNull();
  });

  it('leg 3: the exact-pin lane refuses them too', async () => {
    const ann = await memberWithConnection('ann');
    expect(await secretOf({ tenantId: WS, actingUserId: ann.subject, connectionId: ann.connectionId }), 'the pin resolves while a member').toBe('1:ann');
    expect(await deleteMember(ann.memberId)).toBe(true);
    expect(await secretOf({ tenantId: WS, actingUserId: ann.subject, connectionId: ann.connectionId })).toBeNull();
  });

  it('leg 4: an actor-less send and a non-person actor still get the workspace connection', async () => {
    expect(await secretOf({ tenantId: WS })).toBe('1:workspace');
    expect(await secretOf({ tenantId: WS, actingUserId: 'service:f1-relay' })).toBe('1:workspace');
  });

  it('leg 6: an API key resolves while its issuer is a member, never for another tenant, and not once the issuer has left', async () => {
    const BOB = 'user:f1-bob-ws';
    const bob = await createMember({ orgId: WS, tenantId: WS, displayName: 'Bob', subject: BOB, roles: ['editor'] });
    registerDelegationLookup(async (id) => (
      id === 'f1-bob-key' ? { id, issuer: BOB, tenantId: WS, declaredScopes: [] }
        : id === 'f1-foreign-key' ? { id, issuer: BOB, tenantId: 'ws:f1-elsewhere', declaredScopes: [] }
          : null));
    expect(await secretOf({ tenantId: WS, actingUserId: 'apikey:f1-bob-key' }), 'a live issuer\'s key reaches the workspace connection').toBe('1:workspace');
    expect(await secretOf({ tenantId: WS, actingUserId: 'apikey:f1-foreign-key' }), 'a key bound to another tenant').toBeNull();
    expect(await secretOf({ tenantId: WS, actingUserId: 'apikey:f1-unknown' }), 'an unknown key').toBeNull();
    expect(await deleteMember(bob.memberId)).toBe(true);
    expect(await secretOf({ tenantId: WS, actingUserId: 'apikey:f1-bob-key' }), 'the issuer left, so the key draws nothing').toBeNull();
  });

  it('leg 5: a personal tenant has no member rows and is not refused', async () => {
    const home = 'user:f1-bob-home';
    await createSecretConnection({ tenantId: home, provider: 'telegram', kind: 'bearer', secret: '1:bob', scope: 'user', userId: 'user:f1-bob' });
    expect(await secretOf({ tenantId: home, actingUserId: 'user:f1-bob' })).toBe('1:bob');
  });
});

describe('CHAN-F1 widened — a declared default workspace (ADR 0910), membership only', () => {
  const DW = 'host-f1-default';
  const ELIGIBLE = 'user:f1eeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const CAROL = 'user:f1-carol';
  const OPERATOR = 'user:f1-operator';
  const STRANGER = 'user:f1-stranger';
  const DAN = 'user:f1-dan';
  let carolMemberId = '';
  let operatorMemberId = '';
  let danMemberId = '';
  const live = (subject: string) => ({
    activationId: `opa_${subject}`, workspaceId: DW, subject, eligibilityTenant: ELIGIBLE, justification: 'a reason here',
    activatedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  beforeAll(async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = ELIGIBLE;
    registerMembershipRootedWorkspaces([DW]);
    await createOrg({ tenantId: DW, orgId: DW, createdBy: 'system', name: 'Default root' });
    carolMemberId = (await createMember({ tenantId: DW, orgId: DW, displayName: 'Carol', subject: CAROL, roles: ['viewer'] })).memberId;
    // What `activateOperatorAccess` does: the participant row first, then the live activation.
    operatorMemberId = (await createMember({ tenantId: DW, orgId: DW, displayName: 'Operator', subject: OPERATOR, roles: ['viewer'] })).memberId;
    await operatorActivations.put(live(OPERATOR));
    // A live activation with no membership: ADR 0910 D4/D5 call it no authority.
    await operatorActivations.put(live(STRANGER));
    danMemberId = (await createMember({ tenantId: DW, orgId: DW, displayName: 'Dan', subject: DAN, roles: ['viewer'] })).memberId;
    await createSecretConnection({ tenantId: DW, provider: 'telegram', kind: 'bearer', secret: '1:carol', scope: 'user', userId: CAROL });
    await createSecretConnection({ tenantId: DW, provider: 'telegram', kind: 'bearer', secret: '1:default', scope: 'workspace' });
  });
  afterAll(() => { registerDelegationLookup(async () => null); registerMembershipRootedWorkspaces([]); delete process.env.OPENWOP_SUPERADMIN_TENANTS; });

  it('leg D1: a participant resolves while a member, and nothing once removed', async () => {
    expect(DW.startsWith('ws:'), 'the fixture must NOT be a ws: workspace').toBe(false);
    expect(await secretOf({ tenantId: DW, actingUserId: CAROL })).toBe('1:carol');
    expect(await deleteMember(carolMemberId)).toBe(true);
    expect(await secretOf({ tenantId: DW, actingUserId: CAROL }), 'neither their own nor the workspace connection').toBeNull();
  });

  it('leg D2: an activated operator works through the participant row, and not once that row is removed', async () => {
    expect(isActivationLive(await operatorActivations.get(`${DW}::${OPERATOR}`)), 'the fixture activation is live').toBe(true);
    expect(await secretOf({ tenantId: DW, actingUserId: OPERATOR }), 'D2a').toBe('1:default');
    expect(await deleteMember(operatorMemberId)).toBe(true);
    expect(isActivationLive(await operatorActivations.get(`${DW}::${OPERATOR}`)), 'still live after removal').toBe(true);
    expect(await secretOf({ tenantId: DW, actingUserId: OPERATOR }), 'D2b: a live activation is not presence').toBeNull();
  });

  it('leg D3: a never-member with a live activation resolves nothing', async () => {
    expect(isActivationLive(await operatorActivations.get(`${DW}::${STRANGER}`))).toBe(true);
    expect(await secretOf({ tenantId: DW, actingUserId: STRANGER })).toBeNull();
  });

  it('leg D4: a key resolves while its person issuer is a member here, and not once they have left', async () => {
    registerDelegationLookup(async (id) => (id === 'f1-dan-key' ? { id, issuer: DAN, tenantId: DW, declaredScopes: [] } : null));
    expect(await secretOf({ tenantId: DW, actingUserId: 'apikey:f1-dan-key' }), 'D4a').toBe('1:default');
    expect(await deleteMember(danMemberId)).toBe(true);
    expect(await secretOf({ tenantId: DW, actingUserId: 'apikey:f1-dan-key' }), 'D4b: the issuer left').toBeNull();
  });

  it('leg D6: a key whose delegation vanishes after the issuer check fails closed', async () => {
    const EVE = 'user:f1-eve';
    await createMember({ tenantId: DW, orgId: DW, displayName: 'Eve', subject: EVE, roles: ['viewer'] });
    // The first read (delegationIssuerIsLive) finds the key; the next one (the
    // issuer lookup) finds it revoked: the race this leg pins.
    let reads = 0;
    registerDelegationLookup(async (id) => (id === 'f1-eve-key' && reads++ === 0 ? { id, issuer: EVE, tenantId: DW, declaredScopes: [] } : null));
    expect(await secretOf({ tenantId: DW, actingUserId: 'apikey:f1-eve-key' })).toBeNull();
    expect(reads, 'the issuer lookup ran after the check, so it decided').toBeGreaterThanOrEqual(2);
  });

  it('leg D5: an actor-less send and a non-person actor still get the default workspace connection', async () => {
    expect(await secretOf({ tenantId: DW })).toBe('1:default');
    expect(await secretOf({ tenantId: DW, actingUserId: 'service:f1-relay' })).toBe('1:default');
  });
});
