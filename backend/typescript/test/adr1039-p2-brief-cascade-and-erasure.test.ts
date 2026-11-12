/**
 * ADR 1039 P2 — creative briefs' data lifecycle.
 *
 * D6 (CB82WF-6): `deleteBrief` owns every cascade. The render records and the
 * comment threads used to be purged by the DELETE route only, so the service's
 * other caller (the campaign-showcase demo clear) orphaned both.
 *
 * D7 (CB82WF-7): `eraseCreativeBriefsSubject` tombstones the erased person in
 * every actor field the feature writes (brief `createdBy`/`updatedBy`, version
 * `capturedBy`, render `createdBy`, grounding `updatedBy`), keeps the rows, and
 * never bumps the brief's version or demotes it (an erasure is not an edit).
 *
 * Red when `deleteBrief` stops deleting renders or threads, deletes the brief row
 * before a child cascade that then fails (no retry path), when the eraser misses
 * a field or a stored spelling (`user:<id>` / the doubled `user:user:<id>`), when it
 * touches another person's rows or another tenant, or when it routes through the
 * content writer (version bump / approval demotion).
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createBrief, deleteBrief, getBrief, listVersions, transitionBrief, updateBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { listRenders, storeReelRender, getRender } from '../src/features/creative-briefs/render/renderService.js';
import { getGroundingSettings, setGroundingSettings } from '../src/features/creative-briefs/groundingSettings.js';
import { createComment, __commentsForTenant } from '../src/features/comments/commentsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { eraseCreativeBriefsSubject, ERASED_SUBJECT } from '../src/features/creative-briefs/erasure.js';
import { registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import { hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['creative-briefs', 'media', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const ORG = 'org-p2';

describe('ADR 1039 D6 — deleteBrief owns every cascade', () => {
  it('the service delete (the demo-clear path) removes render records and comment threads; a sibling keeps its own', async () => {
    const T = 'cb-p2-cascade';
    const doomed = await createBrief(T, ORG, 'user:u1', { title: 'Doomed', sceneDescription: 'x' });
    const sibling = await createBrief(T, ORG, 'user:u1', { title: 'Sibling', sceneDescription: 'y' });
    for (const b of [doomed, sibling]) {
      await storeReelRender({ tenantId: T, orgId: ORG, briefId: b.briefId, actor: 'user:u1', videoAssetId: `masset:${b.title}`, prompt: 'p' });
      await createComment({ tenantId: T, orgId: ORG, resourceType: 'creative_brief', resourceId: b.briefId, body: 'a note', authorId: 'user:u1', caller: PREAUTHORIZED_CALLER });
    }
    expect(await deleteBrief(T, ORG, doomed.briefId)).toBe(true);

    await expect(listRenders(T, ORG, doomed.briefId)).rejects.toMatchObject({ code: 'not_found' }); // the brief is gone
    const remaining = (await __commentsForTenant(T)).filter((c) => c.resourceType === 'creative_brief');
    expect(remaining.map((c) => c.resourceId)).toEqual([sibling.briefId]);
    expect(await listRenders(T, ORG, sibling.briefId)).toHaveLength(1);
    // The render ROW of the deleted brief is gone, not merely unreachable through the brief.
    const { listRendersForAssets } = await import('../src/features/creative-briefs/render/renderService.js');
    expect(await listRendersForAssets(T, ORG, new Set(['masset:Doomed']))).toEqual([]);
  });
});

describe('ADR 1039 D6 — a failed cascade fails the delete and keeps the brief (retryable)', () => {
  it('the brief row survives a failed child cascade; a retry completes the delete', async () => {
    const T = 'cb-p2-cascade-fail';
    const b = await createBrief(T, ORG, 'user:u1', { title: 'Retry me', sceneDescription: 'x' });
    await storeReelRender({ tenantId: T, orgId: ORG, briefId: b.briefId, actor: 'user:u1', videoAssetId: 'masset:r', prompt: 'p' });
    // The render store refuses deletes for this tenant: the render cascade fails.
    const real = hostExtStorage();
    let failing = true;
    initHostExtPersistence(new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'kvDelete') {
          return async (key: string) => {
            if (failing && key.startsWith(`hostext:creative-briefs:render:${T}:`)) throw new Error('render store unavailable');
            return target.kvDelete(key);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }));
    try {
      await expect(deleteBrief(T, ORG, b.briefId)).rejects.toThrow(/render store unavailable/);
      expect(await getBrief(T, ORG, b.briefId)).not.toBeNull();
      failing = false;
      expect(await deleteBrief(T, ORG, b.briefId)).toBe(true);
      expect(await getBrief(T, ORG, b.briefId)).toBeNull();
    } finally {
      initHostExtPersistence(real);
    }
  });
});

describe('ADR 1039 D7 — the subject eraser re-attributes, never deletes or edits', () => {
  it('is registered on a real boot', () => {
    expect(registeredSubjectEraserIds()).toContain('eraseCreativeBriefsSubject');
  });

  it('tombstones every actor field the subject holds, in every stored spelling, and nothing else', async () => {
    const T = 'cb-p2-erase';
    // CB-P2-L1 — a tenant id that EXTENDS this one past the key separator, so a
    // `${T}:` prefix scan returns its rows and only the exact tenant check excludes them.
    const OTHER_T = 'cb-p2-erase:x';
    const subject = 'user:erasee';
    // Created by the subject, last edited by someone else.
    const authored = await createBrief(T, ORG, subject, { title: 'Authored', sceneDescription: 'x' });
    await updateBrief(T, ORG, authored.briefId, 'user:peer', { title: 'Authored v2' });
    // Created by a peer, last edited by the subject under the doubled spelling.
    const edited = await createBrief(T, ORG, 'user:peer', { title: 'Edited', sceneDescription: 'x' });
    await updateBrief(T, ORG, edited.briefId, `user:${subject}`, { title: 'Edited v2' });
    await transitionBrief(T, ORG, edited.briefId, `user:${subject}`, 'review');
    await transitionBrief(T, ORG, edited.briefId, `user:${subject}`, 'approved');
    // Entirely a peer's.
    const peers = await createBrief(T, ORG, 'user:peer', { title: 'Peer', sceneDescription: 'x' });
    const reel = await storeReelRender({ tenantId: T, orgId: ORG, briefId: authored.briefId, actor: subject, videoAssetId: 'masset:v', prompt: 'p' });
    const runReel = await storeReelRender({ tenantId: T, orgId: ORG, briefId: authored.briefId, actor: 'run-123', videoAssetId: 'masset:w', prompt: 'p' });
    // CB-P2-L2 — the bare-id spelling a writer may store.
    const bareReel = await storeReelRender({ tenantId: T, orgId: ORG, briefId: peers.briefId, actor: 'erasee', videoAssetId: 'masset:b', prompt: 'p' });
    await setGroundingSettings(T, ORG, subject, { editModeEnabled: true });
    // Another tenant's row by the same subject string must not move.
    const foreign = await createBrief(OTHER_T, ORG, subject, { title: 'Foreign', sceneDescription: 'x' });

    const editedBefore = (await getBrief(T, ORG, edited.briefId))!;
    const report = await eraseCreativeBriefsSubject(T, subject);

    const a = (await getBrief(T, ORG, authored.briefId))!;
    expect(a.createdBy).toBe(ERASED_SUBJECT);
    expect(a.updatedBy).toBe('user:peer');
    const e = (await getBrief(T, ORG, edited.briefId))!;
    expect(e.createdBy).toBe('user:peer');
    expect(e.updatedBy).toBe(ERASED_SUBJECT);
    // Not an edit: no version bump, no demotion of the approved brief.
    expect(e.version).toBe(editedBefore.version);
    expect(e.status).toBe('approved');
    expect((await getBrief(T, ORG, peers.briefId))!).toMatchObject({ createdBy: 'user:peer', updatedBy: 'user:peer' });

    const capturedBy = (await listVersions(T, ORG, authored.briefId)).map((v) => v.capturedBy);
    expect(capturedBy).toContain(ERASED_SUBJECT);
    expect(capturedBy).not.toContain(subject);
    expect((await listVersions(T, ORG, edited.briefId)).map((v) => v.capturedBy)).not.toContain(`user:${subject}`);

    expect((await getRender(T, ORG, authored.briefId, reel.renderId))!.createdBy).toBe(ERASED_SUBJECT);
    expect((await getRender(T, ORG, authored.briefId, runReel.renderId))!.createdBy).toBe('run-123');
    expect((await getRender(T, ORG, peers.briefId, bareReel.renderId))!.createdBy).toBe(ERASED_SUBJECT);
    expect(await getGroundingSettings(T, ORG)).toEqual({ editModeEnabled: true }); // the client's setting is kept

    expect((await getBrief(OTHER_T, ORG, foreign.briefId))!.createdBy).toBe(subject);

    // authored + edited briefs, one version snapshot each, two reels, the grounding row.
    expect(report.rowsTouched).toBe(7);
    // Idempotent: a second pass finds nothing left to rewrite.
    expect((await eraseCreativeBriefsSubject(T, subject)).rowsTouched).toBe(0);
  });

  it('a row it cannot rewrite (every compare-and-swap lost) fails the eraser instead of a smaller success', async () => {
    const T = 'cb-p2-erase-cas';
    await setGroundingSettings(T, ORG, 'user:stuck', { editModeEnabled: false });
    const real = hostExtStorage();
    initHostExtPersistence(new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'kvCompareAndSwap') {
          return async (key: string, ...rest: unknown[]) => (key.startsWith('hostext:creative-briefs:grounding-settings:')
            ? { swapped: false }
            : (target.kvCompareAndSwap as (...a: unknown[]) => Promise<unknown>)(key, ...rest));
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }));
    try {
      await expect(eraseCreativeBriefsSubject(T, 'user:stuck')).rejects.toThrow(/three compare-and-swap attempts/);
    } finally {
      initHostExtPersistence(real);
    }
  });
});
