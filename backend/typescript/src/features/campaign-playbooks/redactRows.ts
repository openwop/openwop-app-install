import type { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/** Erasure must confirm the fresh row, including a writer that raced the scan. */
export async function redactRows<T extends { key: string; tenantId: string }>(
  rows: DurableCollection<T>, tenantId: string, redact: (row: T) => T | null,
): Promise<number> {
  let touched = 0;
  for (const candidate of await rows.listForTenant(tenantId)) {
    if (candidate.tenantId !== tenantId) continue;
    let confirmed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await rows.get(candidate.key);
      if (!current || current.tenantId !== tenantId) { confirmed = true; break; }
      const next = redact(current);
      if (!next) { confirmed = true; break; }
      if (await rows.compareAndSwap(current, next)) { touched++; confirmed = true; break; }
    }
    if (!confirmed) throw new OpenwopError('conflict', 'Playbook erasure could not finish because a row kept changing. Retry the erasure.', 409, { reason: 'playbook_erasure_changed' });
  }
  return touched;
}
