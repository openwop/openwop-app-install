/**
 * Persona service (ADR 0156). Owns the `Persona` entity — CRUD on the generic
 * `DurableCollection`, tenant + org keyed for CTI-1 isolation. A foreign-tenant id
 * reads `null` (fail-closed; the route maps that to a uniform 404).
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { BUYER_STAGES, type BuyerStage, type Persona } from './types.js';

const personas = new DurableCollection<Persona>('campaign-brief:persona', (p) => `${p.tenantId}::${p.id}`);

const NAME_MAX = 160;
const TEXT_MAX = 2000;
const ITEM_MAX = 400;
const LIST_MAX = 50;

export interface PersonaInput {
  name?: unknown;
  role?: unknown;
  buyerStage?: unknown;
  painPoints?: unknown;
  objections?: unknown;
  goals?: unknown;
  demographics?: unknown;
  brandId?: unknown;
}

const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, ITEM_MAX)).filter((v) => v.length > 0) : [];

const BUYER_SET = new Set<string>(BUYER_STAGES);
const asBuyerStage = (raw: unknown, fallback: BuyerStage = 'problem_aware'): BuyerStage =>
  typeof raw === 'string' && BUYER_SET.has(raw) ? (raw as BuyerStage) : fallback;

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

export async function listPersonas(tenantId: string, orgId?: string, brandId?: string): Promise<Persona[]> {
  const all = await personas.listByPrefix(`${tenantId}::`);
  return all
    .filter((p) => (!orgId || p.orgId === orgId) && (!brandId || p.brandId === brandId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPersona(tenantId: string, personaId: string): Promise<Persona | null> {
  const p = await personas.get(tenantKey(tenantId, personaId));
  return p && p.tenantId === tenantId ? p : null;
}

export async function createPersona(tenantId: string, orgId: string, createdBy: string, input: PersonaInput): Promise<Persona> {
  const name = cleanString(input.name, NAME_MAX);
  if (!name) throw new OpenwopError('validation_error', 'A persona name is required.', 400, { field: 'name' });
  const now = new Date().toISOString();
  const persona: Persona = {
    id: randomUUID(),
    tenantId,
    orgId,
    name,
    role: cleanString(input.role, NAME_MAX),
    buyerStage: asBuyerStage(input.buyerStage),
    painPoints: strList(input.painPoints),
    objections: strList(input.objections),
    goals: strList(input.goals),
    demographics: cleanString(input.demographics, TEXT_MAX),
    brandId: optionalCleanString(input.brandId, NAME_MAX),
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await personas.put(persona);
  return persona;
}

export async function updatePersona(tenantId: string, personaId: string, input: PersonaInput): Promise<Persona | null> {
  const existing = await getPersona(tenantId, personaId);
  if (!existing) return null;
  const next: Persona = {
    ...existing,
    name: input.name !== undefined ? cleanString(input.name, NAME_MAX) || existing.name : existing.name,
    role: input.role !== undefined ? cleanString(input.role, NAME_MAX) : existing.role,
    buyerStage: input.buyerStage !== undefined ? asBuyerStage(input.buyerStage, existing.buyerStage) : existing.buyerStage,
    painPoints: input.painPoints !== undefined ? strList(input.painPoints) : existing.painPoints,
    objections: input.objections !== undefined ? strList(input.objections) : existing.objections,
    goals: input.goals !== undefined ? strList(input.goals) : existing.goals,
    demographics: input.demographics !== undefined ? cleanString(input.demographics, TEXT_MAX) : existing.demographics,
    brandId: input.brandId !== undefined ? optionalCleanString(input.brandId, NAME_MAX) : existing.brandId,
    updatedAt: new Date().toISOString(),
  };
  await personas.put(next);
  return next;
}

export async function deletePersona(tenantId: string, personaId: string): Promise<boolean> {
  const existing = await getPersona(tenantId, personaId);
  if (!existing) return false;
  return personas.delete(tenantKey(tenantId, personaId));
}

/** Test-only: drop every persona. */
export async function __clearPersonas(): Promise<void> {
  await personas.__clear();
}
