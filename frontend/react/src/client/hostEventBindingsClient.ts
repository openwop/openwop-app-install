/**
 * Host-event bindings client (ADR 0208 §1) — the admin-UI thin client over
 * `GET/POST/PATCH/DELETE /host/openwop-app/host-events/bindings`. Tenant-
 * scoped on the backend (same trust tier as webhook subscriptions — no
 * superadmin gate); every call is authed + scoped to the caller's tenant.
 */
import { requestJson } from './requestJson.js';

export interface HostEventBinding {
  bindingId: string;
  tenantId: string;
  eventType: string;
  workflowId: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const BASE = '/host/openwop-app/host-events/bindings';

export async function listHostEventBindings(): Promise<HostEventBinding[]> {
  return (await requestJson<{ bindings: HostEventBinding[] }>(BASE)).bindings;
}

export async function createHostEventBinding(input: { eventType: string; workflowId: string }): Promise<HostEventBinding> {
  return requestJson<HostEventBinding>(BASE, { method: 'POST', json: input });
}

export async function setHostEventBindingEnabled(bindingId: string, enabled: boolean): Promise<HostEventBinding> {
  return requestJson<HostEventBinding>(`${BASE}/${encodeURIComponent(bindingId)}`, { method: 'PATCH', json: { enabled } });
}

export async function deleteHostEventBinding(bindingId: string): Promise<void> {
  await requestJson<undefined>(`${BASE}/${encodeURIComponent(bindingId)}`, { method: 'DELETE' });
}
