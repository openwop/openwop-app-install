/**
 * ADR 0982 D1 — a run with exactly the shape the extraction lane accepts, built through the
 * real seams: a personal `user:` tenant whose canonical person exists
 * (`resolveCanonicalUserForTenant`, the fold `/me` runs), a persisted chat (`ensureConversationMeta`,
 * what `POST /chat-sessions` writes) and the run stamped the way `POST /runs` stamps it.
 *
 * Callers must have initialised host-ext persistence first.
 */
import { resolveCanonicalUserForTenant } from '../../src/features/users/usersService.js';
import { ensureConversationMeta } from '../../src/host/conversationStore.js';
import type { RunRecord } from '../../src/types.js';

let seq = 0;

export interface PersonalChat {
  home: string;
  userId: string;
  principal: string;
  /** A fresh conversation run in the person's own tenant. `acting` defaults to the canonical id. */
  run: (opts?: { acting?: string; metadata?: Record<string, unknown>; chat?: boolean }) => Promise<RunRecord>;
}

export async function personalChat(sub: string): Promise<PersonalChat> {
  const principal = `oidc:${sub}`;
  const home = `user:${sub}-home`;
  const person = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: principal, source: 'oidc' });
  return {
    home, userId: person.userId, principal,
    run: async (opts = {}) => {
      const n = ++seq;
      const chatSessionId = `chat-${sub}-${n}`;
      if (opts.chat !== false) await ensureConversationMeta(home, chatSessionId, { type: 'agent', ownerUserId: person.userId });
      const at = '2026-10-26T00:00:00.000Z';
      return {
        runId: `run-${sub}-${n}`, workflowId: 'openwop-app.conversation', tenantId: home, status: 'running', inputs: {},
        metadata: { actingUserId: opts.acting ?? person.userId, chatSessionId, ...(opts.metadata ?? {}) },
        configurable: {}, createdAt: at, updatedAt: at,
      };
    },
  };
}
