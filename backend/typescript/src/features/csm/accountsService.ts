/**
 * CSM accounts store (host-extension, sample-grade — ADR 0001 §6 Phase 6).
 *
 * The second feature, added as a PURE addition (zero core edits) to prove the
 * feature-package contract. Tenant-scoped accounts with a health score, backed
 * by the durable host_ext_kv collection.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';

export interface Account {
  accountId: string;
  tenantId: string;
  name: string;
  healthScore: number; // 0..100
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<Account>('csm:account', (a) => a.accountId);

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 50;
  return Math.max(0, Math.min(100, v));
}

export async function listAccounts(tenantId: string): Promise<Account[]> {
  const all = await store.list();
  return all.filter((a) => a.tenantId === tenantId).sort((a, b) => a.healthScore - b.healthScore);
}

export async function getAccount(accountId: string): Promise<Account | null> {
  return store.get(accountId);
}

export async function createAccount(input: { tenantId: string; name: string; healthScore?: number }): Promise<Account> {
  const now = new Date().toISOString();
  const account: Account = {
    accountId: `csm:${randomUUID()}`,
    tenantId: input.tenantId,
    name: input.name,
    healthScore: clampScore(input.healthScore),
    createdAt: now,
    updatedAt: now,
  };
  await store.put(account);
  return account;
}

export async function updateAccount(accountId: string, patch: { name?: string; healthScore?: number }): Promise<Account | null> {
  const existing = await store.get(accountId);
  if (!existing) return null;
  const next: Account = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.healthScore !== undefined) next.healthScore = clampScore(patch.healthScore);
  await store.put(next);
  return next;
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  return store.delete(accountId);
}

/** Test-only: clear all accounts. */
export async function __resetCsmStore(): Promise<void> {
  await store.__clear();
}
