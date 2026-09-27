/**
 * Agent Author (ADR 0514) — SERVICE unit tests. The authoring brain's
 * invariants, no HTTP:
 *   - closed-world: an out-of-catalog agentId / unresolvable workflow id is
 *     rejected with actionable errors (no throw from validate)
 *   - persona collision is caught at VALIDATE time (the ADR 0379 deterministic
 *     id would 409 at persist — validate says so earlier, model-readably)
 *   - persist creates through the SHARED createRosterEntry path and the agent
 *     lands DISABLED (the draft-never-auto-activate consensus)
 *   - tenant isolation: another tenant's user-agent is not in the catalog
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import {
  buildAgentAuthorCatalog,
  validateAgentDraft,
  persistAgentDraft,
} from '../src/features/agent-author/agentAuthorService.js';
import { getRosterEntry } from '../src/host/rosterService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const TENANT = 'ws-agent-author';

function registerPackAgent(id: string): void {
  getAgentRegistry().register({
    agentId: id,
    persona: 'Pack Agent',
    modelClass: 'general',
    systemPrompt: 'Respond.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
  });
}

function registerForeignUserAgent(id: string, ownerTenant: string): void {
  getAgentRegistry().register({
    agentId: id,
    persona: 'Foreign',
    modelClass: 'general',
    systemPrompt: 'Respond.',
    packName: 'user',
    packVersion: '0',
    toolAllowlist: [],
    ownerTenant,
  } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerPackAgent('test.agent-author.backing');
  registerForeignUserAgent('user.other-tenant-agent', 'someone-else');
});
afterAll(() => {
  getAgentRegistry()._resetForTest();
  __resetHostExtPersistence();
});
afterEach(() => { /* roster rows are tenant-scoped per test persona names */ });

describe('agent-author catalog — tenant closed world', () => {
  it('lists pack agents and HIDES another tenant’s user agent', async () => {
    const c = await buildAgentAuthorCatalog({ tenantId: TENANT });
    expect(c.agents.some((a) => a.agentId === 'test.agent-author.backing')).toBe(true);
    expect(c.agents.some((a) => a.agentId === 'user.other-tenant-agent')).toBe(false);
    expect(c.autonomyLevels).toEqual(['auto', 'guided', 'review']);
  });
});

describe('agent-author validate — closed world with actionable errors', () => {
  it('rejects an invented agentId, names the fix', async () => {
    const v = await validateAgentDraft({ persona: 'Nova', agentId: 'invented.nope' }, { tenantId: TENANT });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/not in the catalog/);
  });

  it('rejects an unresolvable workflow id', async () => {
    const v = await validateAgentDraft(
      { persona: 'Nova', agentId: 'test.agent-author.backing', workflows: ['wf.does-not-exist'] },
      { tenantId: TENANT },
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/does not resolve/);
  });

  it('accepts a minimal valid draft (the polarity that keeps the rejects meaningful)', async () => {
    const v = await validateAgentDraft({ persona: 'Nova Valid', agentId: 'test.agent-author.backing' }, { tenantId: TENANT });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });
});

describe('agent-author persist — the shared path, landing disabled', () => {
  it('creates through createRosterEntry and the agent is DISABLED', async () => {
    const out = await persistAgentDraft(
      { persona: 'Drafted One', agentId: 'test.agent-author.backing', autonomyLevel: 'review' },
      { tenantId: TENANT },
    );
    expect(out.rosterId).toMatch(/^host:/); // the wizard path’s deterministic id
    const row = await getRosterEntry(TENANT, out.rosterId);
    expect(row).not.toBeNull();
    expect(row?.enabled).toBe(false); // draft-never-auto-activate (ADR 0514 §4)
    expect(row?.autonomyLevel).toBe('review');
  });

  it('a persona collision fails at VALIDATE with the model-facing message', async () => {
    const v = await validateAgentDraft({ persona: 'Drafted One', agentId: 'test.agent-author.backing' }, { tenantId: TENANT });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/already exists on the roster/);
  });

  it('an invalid draft REFUSES to persist (typed failure, never success-with-empty)', async () => {
    await expect(persistAgentDraft({ persona: '', agentId: '' }, { tenantId: TENANT })).rejects.toThrow(/not valid/);
  });
});
