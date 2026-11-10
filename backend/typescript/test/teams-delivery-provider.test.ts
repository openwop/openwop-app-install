/**
 * ADR 1042 D2 (CHAN-P0-2) — the provider Teams approval cards are sent through
 * is a real, boot-registered provider that can actually post a Teams chat
 * message.
 *
 * The 2026-11-03 audit read `microsoft365` as a provider "the registry lacks"
 * and proposed switching to `microsoft-graph`. That would have broken delivery:
 * `microsoft365` is the vendored connection pack loaded at boot (Graph host +
 * `ChatMessage.Send`), while the built-in `microsoft-graph` has no chat scope.
 * This file pins both halves so the "fix" cannot land.
 *
 * Red when: the default transport names any provider other than the exported
 * constant, or stops URL-encoding the chat id; the constant names a provider that
 * is not registered from the BOOT roots (`defaultConnectionPackRoots`, what
 * `index.ts` loads); that provider loses the Graph apiHost or `ChatMessage.Send`;
 * `microsoft-graph` is removed (case 2's positive control) or gains `ChatMessage.Send`.
 * Sabotage-witnessed 2026-11-03: setting `TEAMS_DELIVERY_PROVIDER` to
 * `'microsoft-graph'` turned the scope case red, and hard-coding a different
 * provider string in the transport turned the transport case red. /grade-tests
 * w87 (g2 td-*): dropping `encodeURIComponent` turned the transport case red; the
 * boot-root and missing-provider probes read vacuous before this file loaded the
 * boot roots and gained the positive control.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fetchCalls = vi.hoisted((): Array<{ provider: string; url: string }> => []);
vi.mock('../src/host/brokeredEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/brokeredEgress.js')>();
  const brokeredFetch: typeof actual.brokeredFetch = async (_deps, opts) => {
    fetchCalls.push({ provider: opts.provider, url: opts.url });
    return { outcome: 'no_connection' };
  };
  return { ...actual, brokeredFetch };
});

const { openSqliteStorage } = await import('../src/storage/sqlite/index.js');
const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { loadConnectionPacks, defaultConnectionPackRoots } = await import('../src/features/connections/connectionPackLoader.js');
const { getProvider } = await import('../src/features/connections/providerRegistry.js');
const { TEAMS_DELIVERY_PROVIDER, setTeamsDeliveryPref, deliverTeamsApprovalCard } = await import('../src/host/teamsApprovalDelivery.js');

const storage = openSqliteStorage(':memory:');
const savedPackDir = process.env.OPENWOP_CONNECTION_PACKS_DIR;
beforeAll(() => {
  initHostExtPersistence(storage);
  // The boot roots `index.ts` loads (defaultConnectionPackRoots), with no operator dir.
  delete process.env.OPENWOP_CONNECTION_PACKS_DIR;
  expect(loadConnectionPacks({ roots: defaultConnectionPackRoots() }).errors).toEqual([]);
});
afterAll(async () => {
  if (savedPackDir === undefined) delete process.env.OPENWOP_CONNECTION_PACKS_DIR;
  else process.env.OPENWOP_CONNECTION_PACKS_DIR = savedPackDir;
  __resetHostExtPersistence();
  await storage.close();
});

const allScopes = (id: string): string[] => {
  const p = getProvider(id);
  return [...(p?.scopes.read ?? []), ...(p?.scopes.write ?? [])].flatMap((g) => g.scopes);
};

describe('Teams approval delivery provider', () => {
  it('is registered at boot, pinned to Graph, and can send a chat message', () => {
    const p = getProvider(TEAMS_DELIVERY_PROVIDER);
    expect(p, `provider ${TEAMS_DELIVERY_PROVIDER} must be registered`).toBeTruthy();
    expect(p?.apiHosts).toContain('graph.microsoft.com');
    expect(allScopes(TEAMS_DELIVERY_PROVIDER)).toContain('https://graph.microsoft.com/ChatMessage.Send');
  });

  it('the suggested replacement microsoft-graph cannot send a chat message', () => {
    // Positive control: the provider exists and has scopes, so the absence below is real.
    expect(getProvider('microsoft-graph'), 'microsoft-graph must be registered').toBeTruthy();
    expect(allScopes('microsoft-graph')).toContain('https://graph.microsoft.com/Mail.Send');
    expect(allScopes('microsoft-graph')).not.toContain('https://graph.microsoft.com/ChatMessage.Send');
  });

  it('the production transport posts through that provider to the chosen chat', async () => {
    fetchCalls.length = 0;
    await setTeamsDeliveryPref({ tenantId: 't-teams-p', userId: 'usr-bob', connectionId: 'conn:m365', chatId: '19:abc@thread.v2' });
    const sent = await deliverTeamsApprovalCard(storage, {
      notificationId: 'ntf-p1', tenantId: 't-teams-p', type: 'openwop-app.workflow.approval-needed',
      priority: 'high', status: 'unread', title: 'Approve', message: 'Please', createdAt: new Date().toISOString(),
      recipientUserId: 'usr-bob',
    });
    expect(sent).toBe(true);
    expect(fetchCalls).toEqual([{ provider: TEAMS_DELIVERY_PROVIDER, url: 'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/messages' }]);
  });
});
