/**
 * ADR 0820 §8.1 (core-audit §2b.6(iii)) — `comments` DEGRADES when `priority-matrix`
 * is refused.
 *
 * Comments is a different bundle (`content`), but its `priority_idea` target resolver
 * read the priority list and the ranked ideas straight from the priority-matrix service
 * with no feature read, so a tenant without Planning & Strategy could still resolve an
 * idea (its title rides the notification emit) and read its thread. Refused now means
 * the target is NOT FOUND — the uniform `null` every lane already maps to its own
 * refusal (404 on HTTP, `toolEmpty` for the chat tool) — never a throw.
 *
 * SABOTAGE (witnessed, /grade-tests wave 10): removing the `priorityMatrixAllowed`
 * check from the `priority_idea` resolver reds the case (the refused tenant reads
 * its thread again).
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { OpenwopError } from '../src/types.js';
import { createList, submitIdea } from '../src/features/priority-matrix/priorityMatrixService.js';
import { createComment, getComment, listThread } from '../src/features/comments/commentsService.js';

let server: http.Server;
const ORG = 'o-pm';
const FREE = 'cmt-pm-free';
const PAID = 'cmt-pm-paid';
let refuse = false;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['priority-matrix', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (refuse && tenantId === FREE && featureId === 'priority-matrix') throw new OpenwopError('forbidden', 'not on plan', 403, {});
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function seed(tenantId: string): Promise<{ resourceId: string; commentId: string }> {
  const list = await createList(tenantId, ORG, 'u1', { name: 'Roadmap' });
  const idea = await submitIdea(tenantId, list.id, 'u1', { title: 'Secret paid idea' });
  const resourceId = `${list.id}#${idea.id}`;
  const c = await createComment({ tenantId, orgId: ORG, resourceType: 'priority_idea', resourceId, body: 'note', authorId: 'u1', caller: { subject: 'u1' } });
  return { resourceId, commentId: c.comment.commentId };
}

describe('comments degrade when priority-matrix is refused', () => {
  it('a refused tenant resolves the idea thread as NOT FOUND (null, no throw); an entitled one reads it', async () => {
    refuse = false;
    const free = await seed(FREE);
    const paid = await seed(PAID);
    refuse = true;
    await expect(listThread(FREE, ORG, 'priority_idea', free.resourceId, { subject: 'u1' })).resolves.toBeNull();
    await expect(getComment(FREE, ORG, free.commentId, { subject: 'u1' })).resolves.toBeNull();
    // control
    expect((await listThread(PAID, ORG, 'priority_idea', paid.resourceId, { subject: 'u1' }))?.length).toBe(1);
    expect(await getComment(PAID, ORG, paid.commentId, { subject: 'u1' })).not.toBeNull();
  });
});
