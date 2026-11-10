/**
 * ADR 1042 test harness — boots the real app once per file, mints a shared
 * workspace with an editor, a viewer and an outsider, and gives cookie-session
 * helpers. Shared by the `adr1042-*` files so each one tests one CHAN item.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import type { Storage } from '../../src/storage/storage.js';
import type { HostAdapterSuite } from '../../src/host/index.js';

export interface ChannelHarness {
  base: string;
  storage: Storage;
  hostSuite: HostAdapterSuite;
  ws: string;
  editorUserId: string;
  viewerUserId: string;
  editor: () => Promise<string>;
  /** A second editor (a different person with workspace:write). */
  editor2: () => Promise<string>;
  editor2UserId: string;
  viewer: () => Promise<string>;
  outsider: () => Promise<string>;
  call: (path: string, cookie: string, method?: string, body?: unknown) => Promise<{ status: number; body: unknown; headers: Headers }>;
  close: () => Promise<void>;
}

export const CONN = '/host/openwop-app/connections';

export async function bootChannelHarness(tag: string): Promise<ChannelHarness> {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = process.env.OPENWOP_SESSION_SECRET ?? 'test-session-secret-at-least-32-characters-long';
  const { createApp } = await import('../../src/index.js');
  const { createWorkspace, createMember } = await import('../../src/host/accessControlService.js');
  const { userIdFor } = await import('../../src/features/users/usersService.js');
  const { configureKmsClient, createLocalAesKmsClient } = await import('../../src/byok/kmsEncryption.js');
  const { randomBytes } = await import('node:crypto');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  let server!: Server;
  let base = '';
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // A signed-in tenant's secrets are KMS-enveloped; a local AES key stands in.
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ownerSubject = `oidc:${tag}-owner`;
  const editorSubject = `oidc:${tag}-editor`;
  const viewerSubject = `oidc:${tag}-viewer`;
  const editor2Subject = `oidc:${tag}-editor2`;
  const workspace = await createWorkspace({ name: `${tag} workspace`, ownerSubject });
  const ws = workspace.orgId ?? workspace.tenantId;
  await createMember({ orgId: ws, tenantId: ws, displayName: 'Editor', subject: userIdFor(ws, editorSubject), roles: ['editor'] });
  await createMember({ orgId: ws, tenantId: ws, displayName: 'Viewer', subject: userIdFor(ws, viewerSubject), roles: ['viewer'] });
  await createMember({ orgId: ws, tenantId: ws, displayName: 'Editor 2', subject: userIdFor(ws, editor2Subject), roles: ['editor'] });

  async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
    const res = await fetch(`${base}/host/openwop-app/test/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
    });
    expect(res.status, 'test seam must mint a session').toBeLessThan(300);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
  async function call(path: string, cookie: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return {
    base,
    storage: app.locals.storage as Storage,
    hostSuite: app.locals.hostSuite as HostAdapterSuite,
    ws,
    editorUserId: userIdFor(ws, editorSubject),
    viewerUserId: userIdFor(ws, viewerSubject),
    editor: () => login(editorSubject, ws),
    editor2: () => login(editor2Subject, ws),
    editor2UserId: userIdFor(ws, editor2Subject),
    viewer: () => login(viewerSubject, ws),
    outsider: () => login(`oidc:${tag}-outsider`, `user:${tag}-outsider-home`, false),
    call,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Read a nested field of an untyped JSON body, without a cast. */
export function field(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
