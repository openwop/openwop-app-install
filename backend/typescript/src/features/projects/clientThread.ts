/**
 * ADR 1099 D7 (P3c) — a project's client threads: what ONE outside collaborator
 * (a client, a builder) and the firm's members say to each other about ONE project.
 *
 * One thread per (project, collaborator), never one per project: a project can have
 * several outside parties (a client and a builder), and they must not read each
 * other's messages or the firm's replies to the other (the same reason P2 gave a
 * grant an `audience`).
 *
 * A collaborator never writes to it directly. They ask the Project Guide to send a
 * message; `openwop:client.project.message-send` is a `propose` client tool, so the
 * message is held as ONE `collab-proposal` approval and joins the thread only when
 * a member approves it (ADR 1099 goal 2, "messages a member reviews before they
 * count"). A member's reply is the firm speaking, so it joins at once.
 *
 * > **Correction to D7 (P3c):** D7 planned a separate host approval kind,
 * > `project-client-message`. P3a's `collab-proposal` kind already holds one item,
 * > lets a member decide it and applies it through the tool's own `apply`, so the
 * > message is a propose tool on that kind instead of a second kind with the same
 * > recipe.
 *
 * Who reads it: a member with access to the project (`resolveProjectAccess`) reads
 * every thread of the project; a collaborator reads only their own, through a live
 * grant on the project (`checkGrantUse`, `view`).
 *
 * Erasure: a collaborator's erasure deletes the entries they authored; a member's
 * DSAR anonymizes the entries they authored (text and author); a project delete
 * deletes the thread.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getCollaborator, registerCollaboratorEraseHook, registerCollaboratorPurgeHook } from '../../host/externalCollaborators.js';
import { registerClientProjectTool } from '../../host/clientProjectTools.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, ERASED_USER_REF, subjectKeyForms } from '../../host/subjectErasureRedaction.js';

export const CLIENT_MESSAGE_TOOL = 'openwop:client.project.message-send';
export const CLIENT_MESSAGE_MAX_CHARS = 2000;
const SUMMARY_MAX_CHARS = 500;
/** The newest entries a read returns. */
export const CLIENT_THREAD_READ_LIMIT = 200;

export interface ClientThreadEntry {
  entryId: string;
  tenantId: string;
  orgId: string;
  projectId: string;
  /** The collaborator this thread is with (the thread key, with the project). */
  collaboratorId: string;
  author:
    | { kind: 'collaborator'; collaboratorId: string; label: string }
    | { kind: 'member'; userId: string };
  text: string;
  createdAt: string;
  /** The approval a collaborator's message joined through. */
  approvalId?: string;
}

const entries = new DurableCollection<ClientThreadEntry>('projects:client-thread', (e) => e.entryId, undefined, (e) => e.tenantId);

/** A project's threads (one collaborator's when `collaboratorId` is given), oldest
 *  first, capped at the newest {@link CLIENT_THREAD_READ_LIMIT}. */
export async function listClientThread(tenantId: string, projectId: string, collaboratorId?: string): Promise<ClientThreadEntry[]> {
  const rows = (await entries.listForTenantIndexed(tenantId))
    .filter((e) => e.tenantId === tenantId && e.projectId === projectId && (!collaboratorId || e.collaboratorId === collaboratorId));
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId));
  return rows.slice(-CLIENT_THREAD_READ_LIMIT);
}

function cleanText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new OpenwopError('validation_error', '`text` is required.', 400, { field: 'text' });
  if (text.length > CLIENT_MESSAGE_MAX_CHARS) {
    throw new OpenwopError('validation_error', `\`text\` is longer than ${CLIENT_MESSAGE_MAX_CHARS} characters.`, 400, { field: 'text' });
  }
  return text;
}

/** A member's reply to one collaborator: the firm speaking, so it joins at once.
 *  The collaborator must be one of this org's (404 otherwise, the uniform answer). */
export async function appendMemberReply(input: { tenantId: string; orgId: string; projectId: string; collaboratorId: string; userId: string; text: unknown }): Promise<ClientThreadEntry> {
  const text = cleanText(input.text);
  const c = typeof input.collaboratorId === 'string' && input.collaboratorId ? await getCollaborator(input.tenantId, input.orgId, input.collaboratorId) : null;
  if (!c) throw new OpenwopError('not_found', 'Collaborator not found.', 404, {});
  const row: ClientThreadEntry = {
    entryId: `cth_${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId, projectId: input.projectId, collaboratorId: c.collaboratorId,
    author: { kind: 'member', userId: input.userId },
    text,
    createdAt: new Date().toISOString(),
  };
  await entries.put(row);
  return row;
}

/** An approved collaborator message joins the thread, once per approval. */
async function appendApprovedMessage(input: { tenantId: string; orgId: string; projectId: string; collaboratorId: string; text: string; approvalId: string }): Promise<void> {
  const entryId = `cth_${createHash('sha256').update(input.approvalId, 'utf8').digest('hex').slice(0, 32)}`;
  if (await entries.get(entryId)) return; // a reopened-then-approved row joins once
  const c = await getCollaborator(input.tenantId, input.orgId, input.collaboratorId);
  await entries.compareAndSwap(null, {
    entryId,
    tenantId: input.tenantId, orgId: input.orgId, projectId: input.projectId, collaboratorId: input.collaboratorId,
    author: { kind: 'collaborator', collaboratorId: input.collaboratorId, label: c?.displayName ?? 'Outside collaborator' },
    text: input.text,
    createdAt: new Date().toISOString(),
    approvalId: input.approvalId,
  });
}

/** What a collaborator sees of their own thread: no member ids (a member is "the
 *  firm"), and no collaborator id. */
export function collaboratorView(e: ClientThreadEntry): { entryId: string; from: 'you' | 'firm'; text: string; createdAt: string } {
  return { entryId: e.entryId, from: e.author.kind === 'member' ? 'firm' : 'you', text: e.text, createdAt: e.createdAt };
}

let registered = false;
export function registerProjectClientThread(): void {
  if (registered) return;
  registered = true;

  registerClientProjectTool({
    id: CLIENT_MESSAGE_TOOL,
    kind: 'project',
    featureId: 'projects.client-portal',
    effect: 'propose',
    action: 'comment',
    description: `Send the firm a message about this project. A person at the firm reviews it before it is added to the project's messages. Up to ${CLIENT_MESSAGE_MAX_CHARS} characters.`,
    inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: CLIENT_MESSAGE_MAX_CHARS } }, required: ['message'], additionalProperties: false },
    async run(scope, input) {
      const text = cleanText(input.message);
      // The same words on the same grant IN THE SAME HOUR are one message, so a model
      // retrying a call adds nothing. Not forever (casavoga-c9 review): a "thank you"
      // a month later, or a resend after a rejection, is a new message.
      const key = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
      const hour = new Date().toISOString().slice(0, 13);
      return {
        proposals: [{
          groupKey: `messages:${scope.grantId}`,
          idempotencyKey: `message:${key}:${hour}`,
          summary: text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text,
          payload: { text },
        }],
      };
    },
    async apply(scope, payload, ctx) {
      await appendApprovedMessage({
        tenantId: scope.tenantId, orgId: scope.orgId, projectId: scope.resourceId,
        collaboratorId: scope.collaboratorId, text: cleanText(payload.text), approvalId: ctx.approvalId,
      });
    },
  });

  // A collaborator's erasure: their whole thread goes. The firm's replies in it were
  // addressed to that person and quote or answer them, so keeping them would keep the
  // conversation the person asked to have erased.
  const dropThread = async (c: { tenantId: string; collaboratorId: string }): Promise<number> => {
    let n = 0;
    for (const e of await entries.listForTenantIndexed(c.tenantId)) {
      if (e.collaboratorId === c.collaboratorId && (await entries.delete(e.entryId))) n += 1;
    }
    return n;
  };
  registerCollaboratorEraseHook(dropThread);
  // An org teardown deletes the org's collaborators: their threads go with them.
  registerCollaboratorPurgeHook(dropThread);

  // A project delete takes its thread.
  registerSubjectDependent('project', 'clientThread', {
    count: async (tenantId, subject) => (await entries.listForTenantIndexed(tenantId)).filter((e) => e.projectId === subject.id).length,
    purge: async (tenantId, subject) => {
      let n = 0;
      for (const e of await entries.listForTenantIndexed(tenantId)) if (e.projectId === subject.id && (await entries.delete(e.entryId))) n += 1;
      return n;
    },
  });

  registerSubjectEraser(eraseClientThreadSubject);
}

/** ADR 0464 — a member's DSAR anonymizes the replies they wrote (author and text). */
export async function eraseClientThreadSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  let n = 0;
  for (const e of await entries.listForTenantIndexed(tenantId)) {
    if (e.author.kind !== 'member' || e.author.userId === ERASED_USER_REF) continue;
    if (!forms.has(e.author.userId)) continue;
    await entries.put({ ...e, author: { kind: 'member', userId: ERASED_USER_REF }, text: ERASED });
    n += 1;
  }
  return { rowsTouched: n };
}
