/** Shared take routes; source owners supply their EXISTING authorization/revision loader. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createDocument, getDocument, getVersion, listDocuments, addVersion, canReadDocument } from '../documents/documentsService.js';
import { OpenwopError } from '../../types.js';
import { filmTimingHash, validateFilmPerformance, type FilmPerformance } from '../../../../../contracts/filmPerformance.js';
import type { FilmSpec } from '../../../../../contracts/films.js';
export interface PerformanceSource { tenantId: string; orgId: string; userId: string; sourceId: string; revision: string; film: FilmSpec }
interface TakeContent { version: 1; sourceId: string; revision: string; performance: FilmPerformance }
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const missing = () => new OpenwopError('not_found', 'Rehearsal take not found.', 404);
function revisionOf(req: Request): string {
  const v = req.query.revision;
  if (typeof v !== 'string' || !v || v.length > 200) throw new OpenwopError('validation_error', 'An exact saved film revision is required.', 400);
  return v;
}
const kindFor = (s: PerformanceSource) => 'film-take-' + digest(JSON.stringify([s.sourceId, s.revision])).slice(0, 40);
async function readTake(s: PerformanceSource, id: string, hash: string): Promise<{ id: string; name: string; createdAt: string; performance: FilmPerformance } | null> {
  const doc = await getDocument(s.tenantId, s.orgId, id);
  if (!doc || doc.kind !== kindFor(s) || doc.ownerSubject?.kind !== 'user' || doc.ownerSubject.id !== s.userId || !(await canReadDocument(s.tenantId, doc, s.userId))) return null;
  // First version is the take. Later generic Document edits cannot rewrite it.
  const v = await getVersion(s.tenantId, s.orgId, id, `${id}:1`);
  if (!v) return null;
  let content: TakeContent;
  try { content = JSON.parse(v.content) as TakeContent; } catch { return null; }
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.version !== 1 || content.sourceId !== s.sourceId || content.revision !== s.revision) return null;
  if (validateFilmPerformance(s.film, content.performance, hash).length) return null;
  return { id, name: doc.title, createdAt: doc.createdAt, performance: content.performance };
}
export function registerFilmPerformanceRoutes({ app }: Pick<RouteDeps, 'app'>, base: string,
  load: (req: Request, revision: string, need: 'read' | 'write') => Promise<PerformanceSource>): void {
  app.get(base, async (req, res, next) => { try {
    const revision = revisionOf(req);
    const source = await load(req, revision, 'read');
    let canSave = true;
    try { await load(req, revision, 'write'); }
    catch (error) { if (error instanceof OpenwopError && error.httpStatus === 403) canSave = false; else throw error; }
    const after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || after.length > 200)) throw new OpenwopError('validation_error', 'Invalid take cursor.', 400);
    const docs = (await listDocuments(source.tenantId, source.orgId, { kind: kindFor(source), ownerSubject: { kind: 'user', id: source.userId } }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.documentId.localeCompare(b.documentId));
    const start = after ? docs.findIndex(d => d.documentId === after) + 1 : 0;
    if (after && start === 0) throw new OpenwopError('conflict', 'The take list changed. Refresh it.', 409);
    const takes = []; let i = start;
    const hash = await filmTimingHash(source.film);
    for (; i < docs.length && takes.length < 20; i++) {
      const take = await readTake(source, docs[i]!.documentId, hash);
      if (take) takes.push({ id: take.id, name: take.name, createdAt: take.createdAt, durationMs: take.performance.durationMs });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ takes, next: i < docs.length ? docs[i - 1]!.documentId : null, canSave });
  } catch (e) { next(e); } });
  app.get(`${base}/:takeId`, async (req, res, next) => { try {
    const source = await load(req, revisionOf(req), 'read');
    const take = await readTake(source, req.params.takeId, await filmTimingHash(source.film));
    if (!take) throw missing();
    res.setHeader('Cache-Control', 'no-store'); res.json(take);
  } catch (e) { next(e); } });
  app.post(base, async (req, res, next) => { try {
    const source = await load(req, revisionOf(req), 'write');
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).some(k => !['requestId', 'name', 'performance'].includes(k)) || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new OpenwopError('validation_error', 'A take name and stable save request ID are required.', 400);
    const hash = await filmTimingHash(source.film);
    const errors = validateFilmPerformance(source.film, body.performance, hash);
    if (errors.length) throw new OpenwopError('validation_error', 'Rehearsal timing is invalid or belongs to different visuals.', 422, { errors });
    const performance = body.performance as FilmPerformance;
    const id = 'film-take:' + digest(JSON.stringify([source.tenantId, source.orgId, source.sourceId, source.revision, source.userId, body.requestId]));
    const content: TakeContent = { version: 1, sourceId: source.sourceId, revision: source.revision, performance };
    const existing = await getDocument(source.tenantId, source.orgId, id);
    if (existing && (existing.kind !== kindFor(source) || existing.ownerSubject?.kind !== 'user' || existing.ownerSubject.id !== source.userId)) throw missing();
    await createDocument({ tenantId: source.tenantId, orgId: source.orgId, documentId: id, title: body.name.trim(), kind: kindFor(source), format: 'markdown', ownerSubject: { kind: 'user', id: source.userId }, createdBy: source.userId, provenance: { producedBy: { kind: 'user', id: source.userId } } });
    const version = await addVersion(source.tenantId, source.orgId, id, { content: JSON.stringify(content), baseVersionId: null, idempotencyKey: 'first', producedBy: { kind: 'user', id: source.userId } });
    if (!isDeepStrictEqual(JSON.parse(version.content), content)) throw new OpenwopError('conflict', 'This save request already belongs to another take. Keep the unsaved take and use a new request ID.', 409);
    const saved = await readTake(source, id, hash);
    if (!saved) throw new OpenwopError('conflict', 'Take save is incomplete. Retry the same request.', 409);
    res.setHeader('Cache-Control', 'no-store'); res.status(existing ? 200 : 201).json(saved);
  } catch (e) { next(e); } });
}
